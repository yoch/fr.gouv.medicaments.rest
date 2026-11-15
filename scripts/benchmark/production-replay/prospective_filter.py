#!/usr/bin/env python3
"""Sélectionne, dans une nouvelle extraction d'appels, ceux qui sont admissibles pour une
évaluation prospective : postérieurs au gel, et dont les arguments n'ont jamais été vus.

Un appel est écarté si :
- son horodatage est antérieur ou égal à `--after` (date du gel, ISO 8601) ou absent ;
- sa requête normalisée (requête + critères) figure déjà dans un jeu préparé antérieur
  (`--seen` : un ou plusieurs `requests.jsonl`), pour que l'évaluation porte sur des requêtes
  inédites et non sur des répétitions de jeux déjà consultés.

La sortie garde le format d'entrée (JSONL gzip ou non) et s'utilise ensuite avec `bench.py prepare`.
Un rapport d'exclusion (comptes seulement, aucune requête) accompagne la sortie.

  python prospective_filter.py --calls new_calls.jsonl.gz --after 2026-11-15T23:59:59+00:00 \\
      --seen private/prepared/requests.jsonl --out private/prospective/calls_admissible.jsonl.gz
"""
import argparse
import collections
import datetime as dt
import gzip
import json
from pathlib import Path

from bench import load_jsonl, norm


def args_key(args):
    q = args.get('query', args.get('q'))
    return (norm(q), *(norm(args.get(k)) for k in ('dosage', 'forme', 'voie')))


def parse_ts(value):
    if not value:
        return None
    text = str(value).strip().replace(' ', 'T', 1)
    for candidate in (text, text.replace('T', ' ', 1)):
        try:
            ts = dt.datetime.fromisoformat(candidate.replace(' +', '+').replace(' -', '-'))
            return ts if ts.tzinfo else ts.replace(tzinfo=dt.timezone.utc)
        except ValueError:
            continue
    return None


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--calls', required=True)
    p.add_argument('--after', required=True, help='freeze timestamp, ISO 8601 with timezone')
    p.add_argument('--seen', nargs='+', required=True, help='requests.jsonl of every earlier prepared set')
    p.add_argument('--out', required=True)
    a = p.parse_args()
    cutoff = dt.datetime.fromisoformat(a.after)
    if cutoff.tzinfo is None:
        raise SystemExit('--after must carry a timezone')
    seen = set()
    for path in a.seen:
        for r in load_jsonl(path):
            seen.add(args_key(r['original_args']))
    kept, reasons = [], collections.Counter()
    for row in load_jsonl(a.calls):
        ts = parse_ts(row.get('ts') or row.get('log_file_date'))
        if ts is None:
            reasons['missing_timestamp'] += 1
        elif ts <= cutoff:
            reasons['before_freeze'] += 1
        elif row.get('tool') == 'bdpm_search' and isinstance(row.get('args'), dict) and args_key(row['args']) in seen:
            reasons['arguments_already_seen'] += 1
        else:
            kept.append(row)
            continue
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    opener = gzip.open if out.suffix == '.gz' else open
    with opener(out, 'wt', encoding='utf-8') as f:
        for row in kept:
            f.write(json.dumps(row, ensure_ascii=False) + '\n')
    report = {'input_calls': len(kept) + sum(reasons.values()), 'kept_calls': len(kept),
              'excluded': dict(reasons), 'freeze_cutoff': cutoff.isoformat(),
              'seen_sets': [Path(s).as_posix().split('/')[-2:] for s in a.seen],
              'note': 'Comptes seulement ; aucune requête. Les appels conservés restent privés.'}
    Path(str(out) + '.filter_report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
