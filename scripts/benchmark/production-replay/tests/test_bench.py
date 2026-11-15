import argparse
import contextlib
import gzip
import importlib.util
import io
import json
import math
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT));import bench as b

class BenchTests(unittest.TestCase):
    def contract(self):return json.loads((ROOT/'contract.json').read_text())
    def row(self,i,q,question=None,chat=None,args=None,tool='bdpm_search',outcome='results'):
        doc={'type':'medicament','cis':'60000001','denomination':'TEST 10 mg, comprimé'}
        return {'tool_call_id':str(i),'tool':tool,'args':args or {'query':q},'user_question':question or q,
           'chat_id':chat,'run_link':'exact' if chat else None,'model':'synthetic-generator',
           'format':'json','response':json.dumps({'data':[doc] if outcome=='results' else []}),
           'outcome':outcome,'n_results':1 if outcome=='results' else 0,'ts':'2026-01-01 10:00:00 +0100'}
    def prepare(self,root,rows):
        src=root/'rows.jsonl.gz'
        with gzip.open(src,'wt') as f:
            for r in rows:f.write(json.dumps(r)+'\n')
        out=root/'prepared'
        a=argparse.Namespace(out=str(out),contract=str(ROOT/'contract.json'),calls=str(src),index=None,
            summary=None,force=False,seed='test-seed',pilot_size=10)
        with contextlib.redirect_stdout(io.StringIO()):b.prepare(a)
        return out,a
    def payload(self):
        return {'query':'TEST 10 mg','candidates':[{'candidate_id':'c1','evidence':{'denomination':'TEST 10 mg, comprimé'}}]}
    def good(self,grade=3):return {'scope':'identification','query_issue':None,'candidates':[
        {'candidate_id':'c1','grade':grade,'critical_mismatch':False,'review_required':False,
         'criteria':[{'name':'dose','status':'matched'}],
         'evidence':[{'field':'denomination','quote':'10 mg'}],'reason':'Evidence contains requested value.'}]}
    def test_validation_good(self):b.validate_judgment(self.good(),self.payload())
    def test_validation_false_quote(self):
        x=self.good();x['candidates'][0]['evidence'][0]['quote']='100 mg'
        with self.assertRaises(ValueError):b.validate_judgment(x,self.payload())
    def test_validation_wrong_id(self):
        x=self.good();x['candidates'][0]['candidate_id']='c2'
        with self.assertRaises(ValueError):b.validate_judgment(x,self.payload())
    def test_validation_contradiction(self):
        x=self.good();x['candidates'][0]['criteria'][0]['status']='contradicted'
        with self.assertRaises(ValueError):b.validate_judgment(x,self.payload())
    def test_validation_unknown_strict(self):
        x=self.good();x['candidates'][0]['criteria'][0]['status']='unknown'
        with self.assertRaises(ValueError):b.validate_judgment(x,self.payload())
    def test_validation_insufficient_allowed(self):
        x=self.good(None);x['candidates'][0]['evidence']=[]
        b.validate_judgment(x,self.payload())
    def test_validation_bool_not_grade(self):
        x=self.good(True)
        with self.assertRaises(ValueError):b.validate_judgment(x,self.payload())
    def test_args_preserved(self):
        args={'query':'Lévothyrox 75 µg','forme':'non LP'};r,e=b.validate_args(args,self.contract())
        self.assertEqual(r['q'],args['query']);self.assertEqual(r['forme'],'non LP');self.assertEqual(r['limit'],10)
    def test_unknown_args_rejected(self):
        self.assertIsNone(b.validate_args({'query':'x','invented':True},self.contract())[0])
    def test_missing_query_rejected(self):self.assertIsNone(b.validate_args({'forme':'gel'},self.contract())[0])
    def test_historical_json(self):
        r=b.parse_historical(self.row(1,'x'));self.assertEqual(r['parse_status'],'ok');self.assertEqual(len(r['results']),1)
    def test_historical_markdown_human(self):
        r=self.row(1,'x');r.update(format='markdown',response='## 1. TEST — CIS 60000001\n- Match: exact\n- Forme: gel\n- Fiche: https://example.invalid\n')
        x=b.parse_historical(r);self.assertEqual(x['results'][0]['cis'],'60000001');self.assertNotIn('Match',x['results'][0]['document_text'])
    def test_historical_markdown_vet(self):
        r=self.row(1,'x');r.update(format='markdown',response='## 1. TEST CHAT — NUM 0123456\n- Espèces: Chat\n')
        x=b.parse_historical(r);self.assertEqual(x['results'][0]['num'],'0123456')
    def test_missing_not_empty(self):
        r=self.row(1,'x');r['response']=None
        self.assertEqual(b.parse_historical(r)['parse_status'],'missing')
    def test_leakage_group_transitive(self):
        rows=[self.row(1,'A',chat='private1'),self.row(2,'B',chat='private1'),self.row(3,' b ',chat=None),self.row(4,'C',question=' b ')]
        with tempfile.TemporaryDirectory() as t:
            out,a=self.prepare(Path(t),rows);rs=list(b.load_jsonl(out/'requests.jsonl'))
            self.assertEqual(len({r['leakage_group'] for r in rs}),1)
            self.assertEqual(len({r['split'] for r in rs}),1)
            self.assertNotIn('private1',(out/'requests.jsonl').read_text())
            self.assertNotIn('user_question',(out/'requests.jsonl').read_text())
    def test_dedup_preserves_frequency(self):
        with tempfile.TemporaryDirectory() as t:
            out,_=self.prepare(Path(t),[self.row(1,'A'),self.row(2,'A')]);rs=list(b.load_jsonl(out/'requests.jsonl'))
            self.assertEqual(len(rs),1);self.assertEqual(rs[0]['weight_calls'],2)
    def test_duplicate_call_fails(self):
        with tempfile.TemporaryDirectory() as t:
            with self.assertRaises(ValueError):self.prepare(Path(t),[self.row(1,'A'),self.row(1,'B')])
    def test_availability_separate(self):
        with tempfile.TemporaryDirectory() as t:
            out,_=self.prepare(Path(t),[self.row(1,'A'),self.row(2,'B',tool='bdpm_availability')])
            self.assertEqual(len(list(b.load_jsonl(out/'requests.jsonl'))),1)
    def test_locked_guard(self):
        with tempfile.TemporaryDirectory() as t:
            out,_=self.prepare(Path(t),[self.row(1,'A')])
            with self.assertRaises(ValueError):b.select_requests(argparse.Namespace(data=str(out),split='test_locked',unlock_test=False,pilot=False))
    def test_grade_metrics(self):
        g={'a':{'grade':3,'critical_mismatch':False},'b':{'grade':0,'critical_mismatch':True}}
        m=b.metrics_for(['b','a'],g,set(g));self.assertEqual(m['mrr10_grade2plus'],.5)
        self.assertAlmostEqual(m['ndcg_requested_k_pooled'],1/math.log2(3))
        self.assertEqual(m['critical_mismatch_top1'],1)
    def test_limit_one_denominator(self):
        g={'a':{'grade':3,'critical_mismatch':False},'b':{'grade':3,'critical_mismatch':False}}
        self.assertEqual(b.metrics_for(['a'],g,set(g),k=1)['ndcg_requested_k_pooled'],1)
    def test_remote_blocked_before_network(self):
        with tempfile.TemporaryDirectory() as t:
            out,_=self.prepare(Path(t),[self.row(i,str(i)) for i in range(1,30)])
            dest=Path(t)/'pk';a=argparse.Namespace(data=str(out),split='calibration',pilot=False,unlock_test=False,out=str(dest))
            with contextlib.redirect_stdout(io.StringIO()):b.history_packets(a)
            a=argparse.Namespace(packets=str(dest),max_requests=1,base_url='https://example.invalid/v1',allow_remote=False,reviewed_packets_sha256=None)
            with self.assertRaisesRegex(ValueError,'Remote transfer blocked'):b.judge(a)
    def test_source_evidence_no_match_metadata(self):
        x=b.clean_evidence({'cis':'1','score':1,'criteria_match':{'forme':True},'denomination':'x','match_quality':'exact'})
        self.assertEqual(set(x),{'cis','denomination'})
    def test_pooled_packet_score_flow(self):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t);out,_=self.prepare(root,[self.row(i,f'TEST {i}') for i in range(1,45)])
            reqs=[r for r in b.load_jsonl(out/'requests.jsonl') if r['split']=='calibration']
            replay=root/'replay.jsonl';runs=[]
            for r in reqs:
                for s in ['B0','B1','B2']:
                    runs.append({'request_id':r['request_id'],'system':s,'status':'ok','snapshot_id':'s1',
                     'results':[{'type':'medicament','cis':'60000001','denomination':'TEST 10 mg, comprimé'}] if s!='B0' else []})
            b.write_jsonl(replay,runs);b.write_json(str(replay)+'.manifest.json',{'snapshot_id':'s1',
               'requests_sha256':b.filehash(out/'requests.jsonl'),'results_sha256':b.filehash(replay)})
            a=argparse.Namespace(data=str(out),runs=[str(replay)],systems='B0,B1,B2',split='calibration',pilot=False,
                 unlock_test=False,top_k=10,chunk_size=12,reverse_fraction=1,seed='seed',out=str(root/'packets'))
            with contextlib.redirect_stdout(io.StringIO()):b.export_packets(a)
            packets=list(b.load_jsonl(root/'packets/packets.jsonl'));pm=json.loads((root/'packets/manifest.json').read_text())
            judgments=[]
            for p in packets:
                j=self.good();j['candidates'][0]['candidate_id']=p['payload']['candidates'][0]['candidate_id']
                judgments.append({'packet_id':p['packet_id'],'payload_sha256':b.digest(p['payload']),
                    'prompt_sha256':pm['prompt_sha256'],'status':'ok','judgment':j})
            b.write_jsonl(root/'j.jsonl',judgments)
            a=argparse.Namespace(packets=str(root/'packets'),judgments=str(root/'j.jsonl'),secondary=None,bootstrap=100,out=str(root/'scores'))
            with contextlib.redirect_stdout(io.StringIO()):b.score(a)
            report=json.loads((root/'scores/report.json').read_text())
            self.assertEqual(report['requests_rank_scored'],len(reqs))
            self.assertEqual(report['metrics_on_scored_subset_only']['B2']['top1_grade3']['macro'],1)
            self.assertEqual(report['metrics_on_scored_subset_only']['B0']['top1_grade3']['macro'],0)
            text=(root/'packets/packets.jsonl').read_text()
            self.assertNotIn('B0',text);self.assertNotIn('synthetic-generator',text);self.assertNotIn('user_question',text)
    def test_judgment_wrong_rubric_rejected(self):
        with tempfile.TemporaryDirectory() as t:
            p={'packet_id':'p','payload':self.payload()};f=Path(t)/'j.jsonl'
            b.write_jsonl(f,[{'packet_id':'p','prompt_sha256':'bad','payload_sha256':b.digest(p['payload']),'status':'ok','judgment':self.good()}])
            with self.assertRaisesRegex(ValueError,'rubric'):b.collect_grades(f,[p],'good')
    def test_packaging_no_context_field(self):
        text=(ROOT/'prompts/retrieval_judge.md').read_text();self.assertIn('PAS un prescripteur',text)

if __name__=='__main__':unittest.main(verbosity=2)
