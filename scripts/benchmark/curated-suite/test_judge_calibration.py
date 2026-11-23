"""Tests synthétiques de judge_calibration.py (aucune donnée réelle, aucun réseau)."""
import argparse, contextlib, io, json, tempfile, unittest
from pathlib import Path
import judge_calibration as jc


def write_jsonl(p, rows):
    Path(p).write_text(''.join(json.dumps(r) + '\n' for r in rows))


class JudgeCalibrationTests(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory(); root = Path(self.t.name)
        self.suite = root / 'suite.json'
        self.suite.write_text(json.dumps({'cases': [
            {'id': 'c1', 'q': 'TEST 10 mg', 'cluster': 'test', 'family': 'F', 'expectedVariantIds': ['60000001'],
             'expectedIdentityIds': ['60000001', '60000002'], 'trapIds': ['60000003']},
            {'id': 'c2', 'q': 'zzz', 'cluster': 'z', 'family': 'F', 'oos': True}]}))
        self.packets = root / 'packets'; self.packets.mkdir()
        cand = lambda cid, cis: {'candidate_id': cid, 'evidence': {'type': 'medicament', 'cis': cis}}
        write_jsonl(self.packets / 'packets.jsonl', [
            {'packet_id': 'p1', 'request_id': 'cur_c1', 'replica': 0,
             'payload': {'candidates': [cand('a', '60000001'), cand('b', '60000002'), cand('c', '60000003'), cand('d', '69999999')]}},
            {'packet_id': 'p1_reverse', 'request_id': 'cur_c1', 'replica': 1, 'payload': {'candidates': []}},
            {'packet_id': 'p2', 'request_id': 'cur_c2', 'replica': 0, 'payload': {'candidates': [cand('e', '61111111')]}}])
        self.root = root

    def tearDown(self):
        self.t.cleanup()

    def judgments(self, name, grades, conf=None):
        rows = [{'packet_id': 'p1', 'request_id': 'cur_c1', 'replica': 0, 'status': 'ok',
                 'judgment': {'candidates': [{'candidate_id': k, 'grade': g} for k, g in grades.items()]},
                 **({'jev_raw': {'candidates': [{'candidate_id': k, 'grade_confidence': conf[k]} for k in conf]}} if conf else {})},
                {'packet_id': 'p2', 'request_id': 'cur_c2', 'status': 'error'}]
        p = self.root / f'{name}.jsonl'; write_jsonl(p, rows); return p

    def test_gold_classes(self):
        g = jc.gold_classes(self.suite, self.packets)
        self.assertEqual({k[1]: v['cls'] for k, v in g.items()},
                         {'a': 'variant', 'b': 'identity_only', 'c': 'trap', 'd': 'unlabeled', 'e': 'impossible_or_oos'})
        self.assertNotIn(('p1_reverse', 'a'), g)

    def test_correctness_rules_and_hybrid(self):
        good = self.judgments('good', {'a': 3, 'b': 1, 'c': 1, 'd': 0}, conf={'a': .99, 'b': .99, 'c': .99, 'd': .99})
        bad = self.judgments('bad', {'a': 1, 'b': 2, 'c': 3, 'd': None})
        out = self.root / 'r.json'
        a = argparse.Namespace(suite=str(self.suite), packets=str(self.packets), judgments=[f'good={good}', f'bad={bad}'],
                               confidence='good', exclude_suspects=None, out=str(out))
        with contextlib.redirect_stdout(io.StringIO()):
            jc.score(a)
        r = json.loads(out.read_text())
        self.assertEqual(r['judges']['good']['balanced_accuracy'], 1.0)
        self.assertEqual(r['judges']['bad']['balanced_accuracy'], 0.0)
        self.assertEqual(r['judge_error_records'], {'good': 1, 'bad': 1})
        self.assertEqual(r['pairwise']['good_only_correct'], 2)
        # Toutes les confiances >= 0.95 : le juge confiant est retenu partout
        self.assertEqual([h['accuracy'] for h in r['hybrid'] if h['rule'].endswith('0.95 else bad')], [1.0])

    def test_null_grade_is_not_scored(self):
        self.assertIsNone(jc.correct('variant', None))
        self.assertFalse(jc.correct('trap', 2))


if __name__ == '__main__':
    unittest.main(verbosity=2)
