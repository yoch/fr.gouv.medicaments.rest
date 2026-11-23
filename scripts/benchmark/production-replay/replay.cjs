#!/usr/bin/env node
'use strict';
/** Local-only adapter: no HTTP load sent to production and no application source mutation.
 * Node >=20. Run against a clean, explicitly pinned fr.gouv.medicaments.rest worktree.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { performance } = require('node:perf_hooks');

function argumentsMap(argv) {
  const a = {};
  for (let i=0;i<argv.length;i++) {
    const token=argv[i];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument ${token}`);
    const name=token.slice(2);
    if (['unlock-test','confirm-tool-contract','skip-vet','help'].includes(name)) a[name]=true;
    else { if(!argv[i+1] || argv[i+1].startsWith('--')) throw new Error(`Missing value for ${token}`); a[name]=argv[++i]; }
  }
  return a;
}
function sha(x) {return crypto.createHash('sha256').update(x).digest('hex');}
function readJsonl(p) {return fs.readFileSync(p,'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);}
function git(repo,...args) {return execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();}
function privateWrite(file,data) {fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file,data,{mode:0o600});}
function hashFile(p) {return sha(fs.readFileSync(p));}
function walk(root,extensions=null,skipSearchIndexes=true) {
  const results=[];
  function recurse(dir) {for(const e of fs.readdirSync(dir,{withFileTypes:true})) {
    if(e.name==='node_modules'||e.name==='.git'||(skipSearchIndexes&&e.name==='search-indexes')) continue;
    const p=path.join(dir,e.name);
    if(e.isSymbolicLink()) continue;
    if(e.isDirectory()) recurse(p);
    else if(e.isFile()&&(!extensions||extensions.some(x=>e.name.endsWith(x)))) results.push(p);
  }}
  recurse(root); return results.sort();
}
function snapshotDirectory(dir) {
  // May be replaced by --snapshot-manifest for an externally prepared exact source inventory.
  const files=walk(dir,['.txt','.xml','.csv','.json','.msbin','.gz','.zip','.bin'],false);
  if(!files.length) throw new Error('No corpus files found; refusing an empty/invented snapshot');
  const entries=files.map(p=>({path:path.relative(dir,p),bytes:fs.statSync(p).size,sha256:hashFile(p)}));
  return {snapshot_id:'sha256:'+sha(JSON.stringify(entries)),files:entries};
}
function stableManifestId(m) {return m.snapshot_id || ('sha256:'+sha(JSON.stringify(m)));}
function exactSourceManifest(repo) {
  const files=walk(path.join(repo,'src'),['.js','.cjs','.mjs','.json']);
  return files.map(p=>({path:path.relative(repo,p),sha256:hashFile(p)}));
}
function percentile(a,p) {const s=[...a].sort((a,b)=>a-b);return s[Math.min(s.length-1,Math.floor((s.length-1)*p))];}
function rotate(a,n) {return a.slice(n%a.length).concat(a.slice(0,n%a.length));}

function hardChecks(replay, result) {
  const failures=[];
  const ids=result.results.map(r=>(r.type==='medicament_veterinaire'?'anmv:':'bdpm:')+String(r.cis||r.num||''));
  if(new Set(ids).size!==ids.length)failures.push('duplicate_entity');
  if(result.total<result.results.length)failures.push('total_less_than_page_length');
  if(result.results.length>replay.limit)failures.push('limit_exceeded');
  if(replay.source==='human'&&result.results.some(r=>r.type==='medicament_veterinaire'))failures.push('human_source_leak');
  if(replay.source==='veterinary'&&result.results.some(r=>r.type!=='medicament_veterinaire'))failures.push('veterinary_source_leak');
  if(replay.source==='human'&&/^\d{8}$/.test(replay.q.trim())&&result.results.some(r=>String(r.cis)!==replay.q.trim()))failures.push('exact_cis_mismatch');
  return failures;
}

async function main() {
  const a=argumentsMap(process.argv.slice(2));
  if(a.help){console.log('node replay.cjs --repo PATH --expected-sha SHA --data-dir PATH --prepared PATH --out replay.jsonl --split calibration --pilot-ids FILE --confirm-tool-contract [--rounds 4] [--unlock-test]');return;}
  for(const x of ['repo','expected-sha','data-dir','prepared','out']) if(!a[x]) throw new Error(`--${x} required`);
  if(!/^[a-f0-9]{40}$/.test(a['expected-sha']))throw new Error('Use a full exact commit SHA');
  const repo=fs.realpathSync(a.repo),dataDir=fs.realpathSync(a['data-dir']),prepared=path.resolve(a.prepared),output=path.resolve(a.out);
  if(fs.existsSync(output))throw new Error('Output exists: choose another run filename');
  const head=git(repo,'rev-parse','HEAD');
  if(head!==a['expected-sha'])throw new Error(`SHA mismatch: local ${head}, expected ${a['expected-sha']}. Revalidate remote via connector before checkout.`);
  // Untracked private outputs are allowed, tracked source edits are not.
  if(git(repo,'status','--porcelain','--untracked-files=no'))throw new Error('Tracked worktree modifications: commit or isolate them before benchmarking');
  const manifest=JSON.parse(fs.readFileSync(path.join(prepared,'manifest.json'),'utf8'));
  if(hashFile(path.join(prepared,'requests.jsonl'))!==manifest.requests_sha256)throw new Error('Request freeze hash mismatch');
  const contract=JSON.parse(fs.readFileSync(path.join(prepared,'contract.json'),'utf8'));
  if(hashFile(path.join(prepared,'contract.json'))!==manifest.contract_sha256)throw new Error('Contract modified; prepare a new frozen dataset');
  if(!contract.verified_against_production_tool_wrapper&&!a['confirm-tool-contract'])throw new Error('Confirm default limit/source against production wrapper, then use --confirm-tool-contract');
  const split=a.split||'calibration';
  if(!['development','calibration','test_locked'].includes(split))throw new Error('Invalid split');
  if(split==='test_locked'&&!a['unlock-test'])throw new Error('Locked test: explicitly freeze code/snapshot/judge and pass --unlock-test');
  let cases=readJsonl(path.join(prepared,'requests.jsonl')).filter(x=>x.split===split);
  if(a['pilot-ids']) {const ids=new Set(JSON.parse(fs.readFileSync(a['pilot-ids'],'utf8')));cases=cases.filter(x=>ids.has(x.request_id));}
  if(!cases.length)throw new Error('Empty case selection');
  const rounds=Number(a.rounds||4);
  if(!Number.isInteger(rounds)||rounds<1||rounds>20)throw new Error('rounds must be 1..20');
  const srcBefore=exactSourceManifest(repo);
  const corpusSnapshot=a['snapshot-manifest']?JSON.parse(fs.readFileSync(a['snapshot-manifest'],'utf8')):snapshotDirectory(dataDir);
  const snapshotId=stableManifestId(corpusSnapshot);
  process.env.DATA_DIR=dataDir;
  process.env.LOAD_HAS_AVIS='false';
  // Benchmark must not download data. Refuse application attempts using common networking APIs.
  global.fetch=async()=>{throw new Error('NETWORK_DISABLED_DURING_REPLAY');};
  for(const moduleName of ['node:http','node:https']) {
    const module=require(moduleName);
    module.request=()=>{throw new Error('NETWORK_DISABLED_DURING_REPLAY');};
    module.get=()=>{throw new Error('NETWORK_DISABLED_DURING_REPLAY');};
  }
  const req=createRequire(path.join(repo,'package.json'));
  const {loadData}=req('./src/services/dataLoader');
  const {loadVetData}=req('./src/services/vetDataLoader');
  const {executeHybridSearchPage}=req('./src/services/searchOrchestrator');
  const {executeExperimentalSearchPage}=req('./src/search/experimentalSearch');
  const {getConceptStore}=req('./src/search/conceptStore');
  const warnings=[];
  const tLoad=performance.now();await loadData();
  if(a['skip-vet'])warnings.push('Veterinary corpus deliberately not loaded: auto/mixed not equivalent to full production.');
  else await loadVetData();
  const loadMs=performance.now()-tLoad;
  const resolvedEngine=req.resolve('@yoch/frozenminisearch');
  const engineEntrySha=hashFile(resolvedEngine);
  let engineVersion=null,dir=path.dirname(resolvedEngine);
  while(dir!==path.dirname(dir)) {
    const p=path.join(dir,'package.json');
    if(fs.existsSync(p)){const x=JSON.parse(fs.readFileSync(p,'utf8'));if(x.name==='@yoch/frozenminisearch'){engineVersion=x.version;break;}}
    dir=path.dirname(dir);
  }
  const funcs={
    B0:(r)=>executeHybridSearchPage(r.q,r.source,r.page,r.limit,{dosage:r.dosage,forme:r.forme,voie:r.voie}),
    B1:(r)=>executeExperimentalSearchPage(r.q,r.source,r.page,r.limit,{dosage:r.dosage,forme:r.forme,voie:r.voie},{mode:'structured'}),
    B2:(r)=>executeExperimentalSearchPage(r.q,r.source,r.page,r.limit,{dosage:r.dosage,forme:r.forme,voie:r.voie},{mode:'concepts'})
  };
  const names=Object.keys(funcs);const buildStart=performance.now();getConceptStore();const conceptBuildMs=performance.now()-buildStart;
  // Only selected split is touched. Separate build/cold latency from warm ranking comparisons.
  for(const c of cases.slice(0,Math.min(5,cases.length)))for(const s of names)funcs[s](c.replay);
  const outputs=new Map();
  for(let round=0;round<rounds;round++) {
    for(let i=0;i<cases.length;i++) {
      const c=cases[i];let order=rotate(names,(i+round)%names.length);if(round%2)order.reverse();
      for(const s of order) {
        const key=c.request_id+'|'+s;let item=outputs.get(key);
        const start=performance.now();
        try {
          const result=await funcs[s](c.replay);const ms=performance.now()-start;
          if(!result||!Array.isArray(result.results)||typeof result.total!=='number')throw new Error('Unexpected replay shape');
          const stable=JSON.stringify({results:result.results,total:result.total,search:result.search});
          if(!item)item={request_id:c.request_id,system:s,status:'ok',snapshot_id:snapshotId,
             results:result.results,total:result.total,search:result.search,hard_check_failures:hardChecks(c.replay,result),timings_ms:[],response_sha256:sha(stable)};
          else if(item.status!=='ok'||item.response_sha256!==sha(stable))throw new Error('Non-deterministic results across repeats');
          item.timings_ms.push(ms);outputs.set(key,item);
        }catch(e){outputs.set(key,{request_id:c.request_id,system:s,status:'error',snapshot_id:snapshotId,
             error_type:e.name,error_message:String(e.message).slice(0,200),results:[],total:null,timings_ms:[]});}
      }
    }
  }
  if(git(repo,'rev-parse','HEAD')!==head||git(repo,'status','--porcelain','--untracked-files=no')||JSON.stringify(exactSourceManifest(repo))!==JSON.stringify(srcBefore))throw new Error('Code changed during replay: results not published');
  if(!a['snapshot-manifest']){
    if(stableManifestId(snapshotDirectory(dataDir))!==snapshotId)throw new Error('Corpus changed during replay');
  }
  const rows=Array.from(outputs.values());
  for(const row of rows)if(row.timings_ms.length)row.latency={median_ms:percentile(row.timings_ms,.5),p95_repeats_ms:percentile(row.timings_ms,.95)};
  privateWrite(output,rows.map(x=>JSON.stringify(x)).join('\n')+'\n');
  const finalManifest={schema_version:'bdpm-replay/1',code_sha:head,tracked_clean:true,requests_sha256:manifest.requests_sha256,
    contract_sha256:manifest.contract_sha256,tool_contract_confirmed_by_operator:!!a['confirm-tool-contract'],
    snapshot_id:snapshotId,corpus_snapshot:corpusSnapshot,
    runtime_sources_sha256:sha(JSON.stringify(srcBefore)),runtime_files:srcBefore,
    frozenminisearch:{resolved_entry:resolvedEngine,entry_sha256:engineEntrySha,version:engineVersion},
    node:process.version,platform:process.platform,arch:process.arch,split,rounds,
    requests:cases.length,systems:names,warnings,
    load_ms:loadMs,concept_build_ms:conceptBuildMs,
    timing_scope:'direct application pipeline with hydration; NOT HTTP end-to-end; warm runs after explicit concept prebuild',
    memory_shared_process:process.memoryUsage(),
    hard_check_failures:rows.flatMap(r=>(r.hard_check_failures||[]).map(f=>({request_id:r.request_id,system:r.system,failure:f}))),
    missing_vet:a['skip-vet']||false,results_sha256:hashFile(output),network:'application network disabled'};
  privateWrite(output+'.manifest.json',JSON.stringify(finalManifest,null,2)+'\n');
  console.log(JSON.stringify({requests:cases.length,systems:names,code_sha:head,snapshot_id:snapshotId,status:'replayed',errors:rows.filter(r=>r.status!=='ok').length}));
}
main().catch(e=>{console.error(`ERROR: ${e.message}`);process.exitCode=1;});
