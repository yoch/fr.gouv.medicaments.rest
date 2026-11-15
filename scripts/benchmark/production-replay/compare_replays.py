#!/usr/bin/env python3
"""Bilan reproductible des requêtes dont le résultat change entre deux rejeux (sans annotation).

Compare deux sorties de `replay.cjs` sur le même gel de requêtes et le même snapshot de corpus.
Les notes déjà existantes (sorties de `bench.py judge`) peuvent être jointes pour lecture, mais
aucun jugement n'est demandé. Les requêtes de `test_locked` ne sont jamais affichées.

  python compare_replays.py --data private/prepared \\
      --before private/replay_calibration_<a>.jsonl --after private/replay_calibration_<b>.jsonl \\
      [--judgments private/judge_A.jsonl ...] [--show-queries] --out private/changes_calibration.json
"""
import argparse
import collections
import json
from pathlib import Path

from bench import candidate_key, digest, filehash, load_jsonl


def keys(row, k=10):
    return [candidate_key(d) for d in row['results'][:k]] if row.get('status') == 'ok' else None


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--data', required=True, help='prepared directory (requests.jsonl, manifest.json)')
    p.add_argument('--before', required=True)
    p.add_argument('--after', required=True)
    p.add_argument('--judgments', nargs='*', default=[], help='existing judgments to attach (read only)')
    p.add_argument('--show-queries', action='store_true', help='print queries (never for test_locked)')
    p.add_argument('--out', required=True)
    a = p.parse_args()

    data = Path(a.data)
    manifest = json.loads((data / 'manifest.json').read_text())
    if filehash(data / 'requests.jsonl') != manifest['requests_sha256']:
        raise SystemExit('Frozen request file has changed')
    reqs = {r['request_id']: r for r in load_jsonl(data / 'requests.jsonl')}
    sides = {}
    for name, path in [('before', a.before), ('after', a.after)]:
        m = json.loads(Path(str(path) + '.manifest.json').read_text())
        if m['requests_sha256'] != manifest['requests_sha256']:
            raise SystemExit(f'{name}: replay belongs to another request freeze')
        if m['results_sha256'] != filehash(path):
            raise SystemExit(f'{name}: replay output fingerprint mismatch')
        sides[name] = (m, {(r['request_id'], r['system']): r for r in load_jsonl(path)})
    (mb, before), (ma, after) = sides['before'], sides['after']
    if mb['snapshot_id'] != ma['snapshot_id']:
        raise SystemExit('Different corpus snapshots: not comparable')

    grades = {}
    for path in a.judgments:
        for r in load_jsonl(path):
            if r.get('status') == 'ok' and r.get('replica', 0) == 0:
                for c in r['judgment']['candidates']:
                    grades.setdefault((r['request_id'], c['candidate_id']), c.get('grade'))
    grade = lambda rid, key: grades.get((rid, 'cand_' + digest([rid, key])[:18]))

    summary = collections.Counter()
    changes = []
    for (rid, system), rb in sorted(before.items()):
        ra = after.get((rid, system))
        if ra is None:
            summary[(system, 'missing_after')] += 1
            continue
        summary[(system, 'requests')] += 1
        kb, ka = keys(rb), keys(ra)
        if kb == ka:
            continue
        kind = ('status_change' if kb is None or ka is None else
                'empty_to_nonempty' if not kb else 'nonempty_to_empty' if not ka else
                'top1_change' if kb[:1] != ka[:1] else 'set_change' if set(kb) != set(ka) else 'reorder_only')
        summary[(system, kind)] += 1
        split = reqs[rid]['split']
        row = {'request_id': rid, 'split': split, 'system': system, 'kind': kind,
               'total_before': rb.get('total'), 'total_after': ra.get('total'),
               'top10_before': kb, 'top10_after': ka,
               'grades_before': [grade(rid, k) for k in kb or []], 'grades_after': [grade(rid, k) for k in ka or []],
               'unjudged_candidates_after': sum(1 for k in ka or [] if grade(rid, k) is None)}
        if a.show_queries and split != 'test_locked':
            row['query'] = reqs[rid]['replay']['q']
        changes.append(row)
    report = {'before': {'code_sha': mb['code_sha'], 'results_sha256': mb['results_sha256']},
              'after': {'code_sha': ma['code_sha'], 'results_sha256': ma['results_sha256']},
              'snapshot_id': ma['snapshot_id'], 'requests_sha256': manifest['requests_sha256'],
              'judgments_attached': [Path(p).name for p in a.judgments], 'new_annotations': 0,
              'summary': {f'{s}:{k}': v for (s, k), v in sorted(summary.items())}, 'changes': changes}
    Path(a.out).write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'summary': report['summary'], 'changed': len(changes)}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
