"""compare_replays.py et prospective_filter.py sur données synthétiques uniquement."""
import gzip, json, subprocess, sys, tempfile, unittest
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT)); import bench as b


def run(*args):
    return subprocess.run([sys.executable, *args], cwd=ROOT, capture_output=True, text=True, check=True)


class ToolTests(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory(); self.root = Path(self.t.name)
        self.data = self.root / 'prepared'; self.data.mkdir()
        reqs = [{'request_id': 'req_1', 'split': 'calibration', 'replay': {'q': 'TEST 10 mg'}, 'original_args': {'query': 'TEST 10 mg'}},
                {'request_id': 'req_2', 'split': 'test_locked', 'replay': {'q': 'SECRET'}, 'original_args': {'query': 'SECRET'}}]
        b.write_jsonl(self.data / 'requests.jsonl', reqs)
        (self.data / 'manifest.json').write_text(json.dumps({'requests_sha256': b.filehash(self.data / 'requests.jsonl')}))

    def tearDown(self):
        self.t.cleanup()

    def replay(self, name, results):
        p = self.root / name
        rows = [{'request_id': rid, 'system': s, 'status': 'ok', 'total': len(res), 'results': res}
                for (rid, s), res in results.items()]
        b.write_jsonl(p, rows)
        b.write_json(str(p) + '.manifest.json', {'requests_sha256': b.filehash(self.data / 'requests.jsonl'),
                                                 'results_sha256': b.filehash(p), 'snapshot_id': 's1', 'code_sha': name})
        return p

    def test_compare_replays_reports_changes_without_locked_queries(self):
        d = lambda cis: {'type': 'medicament', 'cis': cis}
        before = self.replay('a.jsonl', {('req_1', 'B2'): [d('60000001')], ('req_2', 'B2'): [d('60000002')], ('req_1', 'B0'): [d('1')]})
        after = self.replay('b.jsonl', {('req_1', 'B2'): [d('60000003'), d('60000001')], ('req_2', 'B2'): [], ('req_1', 'B0'): [d('1')]})
        out = self.root / 'changes.json'
        run('compare_replays.py', '--data', str(self.data), '--before', str(before), '--after', str(after), '--show-queries', '--out', str(out))
        r = json.loads(out.read_text())
        kinds = {(c['request_id'], c['system']): c['kind'] for c in r['changes']}
        self.assertEqual(kinds, {('req_1', 'B2'): 'top1_change', ('req_2', 'B2'): 'nonempty_to_empty'})
        self.assertEqual(r['new_annotations'], 0)
        self.assertNotIn('SECRET', out.read_text())
        self.assertIn('TEST 10 mg', out.read_text())

    def test_prospective_filter_keeps_only_new_unseen_calls(self):
        calls = self.root / 'calls.jsonl.gz'
        rows = [{'tool_call_id': '1', 'tool': 'bdpm_search', 'args': {'query': 'test 10 mg'}, 'ts': '2026-12-01 10:00:00 +0100'},
                {'tool_call_id': '2', 'tool': 'bdpm_search', 'args': {'query': 'NOUVEAU'}, 'ts': '2026-12-01 10:00:00 +0100'},
                {'tool_call_id': '3', 'tool': 'bdpm_search', 'args': {'query': 'NOUVEAU'}, 'ts': '2026-11-01 10:00:00 +0100'},
                {'tool_call_id': '4', 'tool': 'bdpm_search', 'args': {'query': 'AUTRE'}}]
        with gzip.open(calls, 'wt') as f:
            for r in rows: f.write(json.dumps(r) + '\n')
        out = self.root / 'kept.jsonl.gz'
        run('prospective_filter.py', '--calls', str(calls), '--after', '2026-11-15T23:59:59+00:00',
            '--seen', str(self.data / 'requests.jsonl'), '--out', str(out))
        kept = [json.loads(l) for l in gzip.open(out, 'rt')]
        self.assertEqual([r['tool_call_id'] for r in kept], ['2'])
        rep = json.loads(Path(str(out) + '.filter_report.json').read_text())
        self.assertEqual(rep['excluded'], {'arguments_already_seen': 1, 'before_freeze': 1, 'missing_timestamp': 1})


if __name__ == '__main__':
    unittest.main(verbosity=2)
