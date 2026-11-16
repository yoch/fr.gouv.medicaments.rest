"""End-to-end tests use ONLY synthetic data, a loopback mock judge and a synthetic git repo."""
import argparse
import contextlib
import http.server
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT));import bench as b
import test_bench as tb

class EndToEndTests(unittest.TestCase):
    def test_loopback_judge_and_resume(self):
        helper=tb.BenchTests()
        with tempfile.TemporaryDirectory() as t:
            root=Path(t);data,_=helper.prepare(root,[helper.row(i,f'PRODUCT {i}') for i in range(1,50)])
            pk=root/'packets'
            with contextlib.redirect_stdout(io.StringIO()):
                b.history_packets(argparse.Namespace(data=str(data),split='calibration',pilot=True,unlock_test=False,out=str(pk)))
            calls=[];served_model={}
            class Handler(http.server.BaseHTTPRequestHandler):
                def log_message(self,*args):pass
                def do_POST(self):
                    body=json.loads(self.rfile.read(int(self.headers['Content-Length'])));calls.append(body)
                    payload=json.loads(body['messages'][1]['content']);judged=[]
                    for c in payload['candidates']:
                        judged.append({'candidate_id':c['candidate_id'],'grade':3,'critical_mismatch':False,
                          'review_required':False,'criteria':[],
                          'evidence':[{'field':'denomination','quote':'TEST'}],'reason':'Synthetic fixture.'})
                    result={'scope':'identification','query_issue':None,'candidates':judged}
                    answer={'id':'mock','model':served_model.get('value') or body['model'],
                            'choices':[{'finish_reason':'stop','message':{'content':json.dumps(result)}}],
                            'usage':{'prompt_tokens':10,'completion_tokens':10}}
                    raw=json.dumps(answer).encode();self.send_response(200);self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
            server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            try:
                a=argparse.Namespace(packets=str(pk),base_url=f'http://127.0.0.1:{server.server_port}/v1',model='synthetic-judge',
                    key_env='UNSET_TEST_KEY',out=str(root/'j.jsonl'),max_requests=100,max_output_tokens=2000,
                    temperature=None,timeout=5,allow_remote=False,reviewed_packets_sha256=None,execute=True,structured=True)
                with contextlib.redirect_stdout(io.StringIO()):b.judge(a)
                count=len(calls);self.assertGreater(count,0)
                with contextlib.redirect_stdout(io.StringIO()):b.judge(a)
                self.assertEqual(len(calls),count)
                rows=b.load_jsonl(root/'j.jsonl')
                self.assertTrue(all(r['status']=='ok' for r in rows))
                self.assertTrue(all(r['served_model']=='synthetic-judge' for r in rows))
                # A reroute to another model is an error record, never a grade
                served_model['value']='other-model'
                a.out=str(root/'j_mismatch.jsonl')
                with contextlib.redirect_stdout(io.StringIO()):b.judge(a)
                bad=b.load_jsonl(root/'j_mismatch.jsonl')
                self.assertTrue(bad and all(r['status']=='error' and 'Served model mismatch' in r['error_message'] for r in bad))
                self.assertFalse(any('judgment' in r for r in bad))
            finally:server.shutdown();server.server_close();thread.join()
    @unittest.skipUnless(shutil.which('git') and shutil.which('node'),'Local git/node required')
    def test_node_replay_clean_synthetic_repository(self):
        helper=tb.BenchTests()
        with tempfile.TemporaryDirectory() as t:
            root=Path(t);data,_=helper.prepare(root,[helper.row(i,f'PRODUCT {i}',args={'query':f'PRODUCT {i}','forme':'comprimé'}) for i in range(1,50)])
            repo=root/'fixture';repo.mkdir();corpus=root/'corpus';corpus.mkdir();(corpus/'CIS_bdpm.txt').write_text('SYNTHETIC_DATA_ONLY')
            def write(name,txt):
                p=repo/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(txt)
            write('package.json','{"name":"synthetic-pharma-fixture","version":"0.0.0","type":"commonjs"}')
            write('src/services/dataLoader.js','exports.loadData=async()=>{};')
            write('src/services/vetDataLoader.js','exports.loadVetData=async()=>{};')
            fn="""(q,source,page,limit,c)=>({results:[{type:'medicament',cis:'60000001',denomination:'TEST 10 mg, comprimé',forme_pharma:c.forme}],total:1,search:{source}})"""
            write('src/services/searchOrchestrator.js','exports.executeHybridSearchPage='+fn+';')
            write('src/search/experimentalSearch.js','exports.executeExperimentalSearchPage='+fn+';')
            write('src/search/conceptStore.js','exports.getConceptStore=()=>({});')
            write('node_modules/@yoch/frozenminisearch/package.json','{"name":"@yoch/frozenminisearch","version":"0.0.0-synthetic","main":"index.js"}')
            write('node_modules/@yoch/frozenminisearch/index.js','module.exports={};')
            write('.gitignore','node_modules/\n')
            def git(*args):return subprocess.check_output(['git','-C',str(repo),*args],stderr=subprocess.DEVNULL,text=True).strip()
            git('init');git('add','.');git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','Synthetic fixture')
            sha=git('rev-parse','HEAD');out=root/'run.jsonl'
            result=subprocess.run(['node',str(ROOT/'replay.cjs'),'--repo',str(repo),'--expected-sha',sha,
                '--data-dir',str(corpus),'--prepared',str(data),'--out',str(out),'--split','calibration',
                '--rounds','2','--confirm-tool-contract'],capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            results=list(b.load_jsonl(out));self.assertGreater(len(results),0)
            self.assertTrue(all(x['status']=='ok' for x in results))
            self.assertTrue(all(len(x['timings_ms'])==2 for x in results))
            self.assertTrue(all(x['results'][0]['forme_pharma']=='comprimé' for x in results))
            self.assertEqual(git('status','--porcelain','--untracked-files=no'),'')
            m=json.loads(Path(str(out)+'.manifest.json').read_text());self.assertEqual(m['code_sha'],sha)
            self.assertEqual(m['hard_check_failures'],[])
    def test_context_export_requires_opt_in(self):
        with self.assertRaisesRegex(ValueError,'include-user-context'):
            b.context_packets(argparse.Namespace(include_user_context=False))
    def test_context_schema(self):
        b.validate_context({'alignment':'unknown','lost_constraints':[],'added_constraints':[],
          'reason':'Earlier context unavailable','review_required':True})

if __name__=='__main__':unittest.main(verbosity=2)
