#!/usr/bin/env python3
"""Calibration automatique des juges LLM contre la vérité connue de la suite curée.

Sans relecture humaine, la suite curée sert d'étalon : chaque candidat jugé est rapproché de
la réponse attendue du cas (bonne variante, bonne identité, piège). Données publiques uniquement.

  # 1. Convertir la suite au format `prepared` du banc, puis rejouer et construire les packets
  python judge_calibration.py prepare --suite eval_suite_v3.json \\
      --contract ../production-replay/contract.json --out /hors-depot/prepared
  node ../production-replay/replay.cjs --prepared /hors-depot/prepared --split calibration ...
  python ../production-replay/bench.py packets --data /hors-depot/prepared --runs ... --out /hors-depot/packets
  # 2. Juger (bench.py judge, autre juge), puis comparer à la vérité
  python judge_calibration.py score --suite eval_suite_v3.json --packets /hors-depot/packets \\
      --judgments A=/hors-depot/judge_A.jsonl B=/hors-depot/judge_B.jsonl \\
      [--confidence B] [--exclude-suspects eval_suite_v3.suspects.json] --out report.json

Règles de justesse, dérivées de la rubrique (`prompts/retrieval_judge.md`) :
- bonne variante (`expectedVariantIds`) : grade >= 2 attendu ;
- piège (`trapIds` : mauvaise dose, sel, espèce...) : grade <= 1 attendu ;
- bonne identité, autre variante, et cas impossibles / hors périmètre : distribution seulement.
Une note nulle ou une erreur de jugement n'est jamais comptée juste ni fausse : couverture à part.
"""
import argparse
import collections
import hashlib
import json
import math
from pathlib import Path


def canonical(x):
    return json.dumps(x, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def filehash(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def load_jsonl(p):
    return [json.loads(line) for line in open(p, encoding='utf-8') if line.strip()]


def prepare(a):
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=False)
    suite = json.loads(Path(a.suite).read_text())
    rows = []
    for c in suite['cases']:
        rows.append({'request_id': 'cur_' + c['id'], 'tool': 'bdpm_search',
                     'original_args': {'query': c['q'], **({'source': c['source']} if c.get('source') else {})},
                     'replay': {'q': c['q'], 'source': c.get('source') or 'auto', 'page': 1, 'limit': 10,
                                'dosage': None, 'forme': None, 'voie': None},
                     'weight_calls': 1, 'historical_outcomes': {}, 'months': {}, 'models': {},
                     'tags': [c['family']], 'privacy_flags': [],
                     'leakage_group': 'group_' + hashlib.sha256(c['cluster'].encode()).hexdigest()[:20],
                     'split': 'calibration'})
    (out / 'requests.jsonl').write_text(''.join(canonical(r) + '\n' for r in rows))
    (out / 'contract.json').write_text(Path(a.contract).read_text())
    (out / 'manifest.json').write_text(json.dumps({
        'version': 'curated-calibration/1', 'source_suite': Path(a.suite).name,
        'source_suite_sha256': filehash(a.suite), 'requests_sha256': filehash(out / 'requests.jsonl'),
        'contract_sha256': filehash(out / 'contract.json'),
        'purpose': 'JUDGE_CALIBRATION_AGAINST_KNOWN_ANSWERS', 'public_data_only': True}, indent=2) + '\n')
    print(json.dumps({'requests': len(rows), 'out': str(out)}))


def gold_classes(suite_path, packets_dir, exclude=frozenset()):
    cases = {'cur_' + c['id']: c for c in json.loads(Path(suite_path).read_text())['cases']}
    gold = {}
    for p in load_jsonl(Path(packets_dir) / 'packets.jsonl'):
        if p['replica'] != 0:
            continue
        c = cases.get(p['request_id'])
        if c is None or c['id'] in exclude:
            continue
        var = set(c.get('expectedVariantIds') or [])
        ident = set(c.get('expectedIdentityIds') or [])
        trap = set(c.get('trapIds') or [])
        for cand in p['payload']['candidates']:
            ev = cand['evidence']
            key = str(ev.get('num') if ev.get('type') == 'medicament_veterinaire' else ev.get('cis'))
            if c.get('oos') or c.get('impossible'):
                cls = 'impossible_or_oos'
            elif key in var:
                cls = 'variant'
            elif key in trap:
                cls = 'trap'
            elif key in ident:
                cls = 'identity_only'
            else:
                cls = 'unlabeled'
            gold[(p['packet_id'], cand['candidate_id'])] = {'cls': cls, 'case': c['id']}
    return gold


def judge_grades(path):
    """Notes par (packet, candidat), confiance si le juge l'archive (`jev_raw`)."""
    grades = {}
    errors = 0
    for r in load_jsonl(path):
        if r.get('status') != 'ok':
            errors += 1
            continue
        if r.get('replica', 0) != 0:
            continue
        raw = {c.get('candidate_id'): c for c in (r.get('jev_raw') or {}).get('candidates', [])}
        for c in r['judgment']['candidates']:
            grades[(r['packet_id'], c['candidate_id'])] = {
                'grade': c.get('grade'), 'conf': raw.get(c['candidate_id'], {}).get('grade_confidence')}
    return grades, errors


def correct(cls, grade):
    if grade is None:
        return None
    if cls == 'variant':
        return grade >= 2
    if cls == 'trap':
        return grade <= 1
    return None


def wilson(k, n):
    if n == 0:
        return [None, None]
    z = 1.96
    p = k / n
    d = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / d
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return [round(centre - half, 3), round(centre + half, 3)]


def judge_report(grades, gold):
    by = collections.defaultdict(list)
    for k, v in gold.items():
        by[v['cls']].append(grades[k]['grade'] if k in grades else 'missing')
    out = {}
    for cls, gs in sorted(by.items()):
        dist = collections.Counter('missing' if x == 'missing' else ('null' if x is None else x) for x in gs)
        out[cls] = {'n': len(gs), 'distribution': {str(k): v for k, v in sorted(dist.items(), key=str)}}
    for cls in ['variant', 'trap']:
        if cls not in out:
            continue
        gs = [x for x in by[cls] if x not in ('missing', None)]
        k = sum(correct(cls, x) for x in gs)
        out[cls].update(scored=len(gs), correct=k, accuracy=round(k / len(gs), 3) if gs else None, ci95=wilson(k, len(gs)))
    va = out.get('variant', {}).get('accuracy')
    tr = out.get('trap', {}).get('accuracy')
    out['balanced_accuracy'] = round((va + tr) / 2, 3) if va is not None and tr is not None else None
    io = [x for x in by.get('impossible_or_oos', []) if x not in ('missing', None)]
    out['impossible_or_oos_grade3'] = f"{sum(1 for x in io if x == 3)}/{len(io)}"
    return out


def score(a):
    exclude = frozenset()
    if a.exclude_suspects:
        exclude = frozenset(s['id'] for s in json.loads(Path(a.exclude_suspects).read_text())['suspects'])
    gold = gold_classes(a.suite, a.packets, exclude)
    judges = {}
    for spec in a.judgments:
        name, _, path = spec.partition('=')
        if not path:
            raise SystemExit('--judgments expects NAME=PATH')
        judges[name] = judge_grades(path)
    report = {'suite_sha256': filehash(a.suite), 'excluded_cases': sorted(exclude),
              'gold_counts': dict(collections.Counter(v['cls'] for v in gold.values())),
              'judge_error_records': {n: e for n, (_, e) in judges.items()},
              'judges': {n: judge_report(g, gold) for n, (g, _) in judges.items()}}
    labeled = [k for k, v in gold.items() if v['cls'] in ('variant', 'trap')]
    names = list(judges)
    if len(names) == 2:
        (ga, _), (gb, _) = judges[names[0]], judges[names[1]]
        both = [k for k in labeled if ga.get(k, {}).get('grade') is not None and gb.get(k, {}).get('grade') is not None]
        ok = lambda g, k: correct(gold[k]['cls'], g[k]['grade'])
        report['pairwise'] = {
            'n': len(both), 'same_grade': round(sum(ga[k]['grade'] == gb[k]['grade'] for k in both) / max(1, len(both)), 3),
            'both_correct': sum(ok(ga, k) and ok(gb, k) for k in both),
            f'{names[0]}_only_correct': sum(ok(ga, k) and not ok(gb, k) for k in both),
            f'{names[1]}_only_correct': sum(ok(gb, k) and not ok(ga, k) for k in both),
            'both_wrong': [gold[k]['case'] for k in both if not ok(ga, k) and not ok(gb, k)]}
        if a.confidence in judges:
            first = a.confidence
            other = names[1] if first == names[0] else names[0]
            gf, go = judges[first][0], judges[other][0]
            ks = [k for k in both if gf[k]['conf'] is not None]
            bins = [(0, .5), (.5, .7), (.7, .8), (.8, .9), (.9, .95), (.95, 1.01)]
            report['confidence_vs_accuracy'] = [
                {'conf': f'[{lo},{hi})', 'n': len(sel),
                 'accuracy': round(sum(ok(gf, k) for k in sel) / len(sel), 3) if sel else None}
                for lo, hi in bins for sel in [[k for k in ks if lo <= gf[k]['conf'] < hi]]]
            report['hybrid'] = []
            for t in [0, .5, .7, .8, .9, .95, 1.01]:
                pick = lambda k: gf[k]['grade'] if gf[k]['conf'] >= t else go[k]['grade']
                report['hybrid'].append({'rule': f'{first} if confidence >= {t} else {other}', 'n': len(ks),
                    'fallback_share': round(sum(gf[k]['conf'] < t for k in ks) / max(1, len(ks)), 3),
                    'accuracy': round(sum(correct(gold[k]['cls'], pick(k)) for k in ks) / max(1, len(ks)), 3)})
    Path(a.out).write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False, indent=2))


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest='command', required=True)
    x = sub.add_parser('prepare')
    x.add_argument('--suite', required=True)
    x.add_argument('--contract', required=True)
    x.add_argument('--out', required=True)
    x.set_defaults(func=prepare)
    x = sub.add_parser('score')
    x.add_argument('--suite', required=True)
    x.add_argument('--packets', required=True)
    x.add_argument('--judgments', nargs='+', required=True, help='NAME=PATH, one or two judges')
    x.add_argument('--confidence', help='Judge whose archived confidence drives the hybrid simulation')
    x.add_argument('--exclude-suspects', help='JSON listing cases whose expected answer is suspect')
    x.add_argument('--out', required=True)
    x.set_defaults(func=score)
    a = p.parse_args()
    a.func(a)


if __name__ == '__main__':
    main()
