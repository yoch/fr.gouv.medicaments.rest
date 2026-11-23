#!/usr/bin/env python3
"""Offline-first production search benchmark. Python >=3.10, standard library only.
Raw logs and outputs must stay outside a public repository. No network in prepare/export/score.
"""
from __future__ import annotations
import argparse
import collections
import csv
import datetime as dt
import gzip
import hashlib
import ipaddress
import json
import math
import os
from pathlib import Path
import random
import re
import secrets
import statistics
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parent
VERSION = 'bdpm-prod-bench/1.0'

def canonical(x):
    return json.dumps(x, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)

def digest(x):
    return hashlib.sha256((x if isinstance(x, bytes) else canonical(x).encode())).hexdigest()

def filehash(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''): h.update(b)
    return h.hexdigest()

def load_jsonl(p):
    p = Path(p)
    op = gzip.open if p.suffix == '.gz' else open
    with op(p, 'rt', encoding='utf-8') as f:
        for n, line in enumerate(f, 1):
            if line.strip():
                try: yield json.loads(line)
                except Exception as e: raise ValueError(f'{p.name}: invalid JSON at line {n}') from e

def write_json(p, obj):
    p = Path(p); p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(obj, ensure_ascii=False, indent=2, allow_nan=False) + '\n')
    os.chmod(p, 0o600)

def write_jsonl(p, rows):
    p = Path(p); p.parent.mkdir(parents=True, exist_ok=True)
    with p.open('w', encoding='utf-8') as f:
        for row in rows: f.write(canonical(row) + '\n')
    os.chmod(p, 0o600)

def norm(s):
    # Only for grouping. Never used to modify replayed arguments or doses.
    return ' '.join(unicodedata.normalize('NFKC', str(s or '')).casefold().split())

def pii_flags(s):
    s = str(s or '')
    flags=[]
    if re.search(r'[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}', s): flags.append('email')
    if re.search(r'(?:\+\d{1,3}[ .-]?)?(?:\d{2}[ .-]){4}\d{2}', s): flags.append('phone_like')
    if re.search(r'\b(?:M\.|Mme|Madame|Monsieur|patient[e]? nomm[eé]e?)\s+[A-ZÀ-Ö][a-zà-ö]+', s): flags.append('person_like')
    return flags

def scrub(s):
    s = str(s or '')
    s = re.sub(r'[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}', '[EMAIL]', s)
    return re.sub(r'(?:\+\d{1,3}[ .-]?)?(?:\d{2}[ .-]){4}\d{2}', '[PHONE]', s)

class DSU:
    def __init__(self,n): self.p=list(range(n))
    def find(self,x):
        while self.p[x]!=x:
            self.p[x]=self.p[self.p[x]];x=self.p[x]
        return x
    def union(self,a,b): self.p[self.find(a)]=self.find(b)

ALLOWED_ARGS={'query','q','dosage','forme','voie','source','limit','page'}

def validate_args(args, contract):
    if not isinstance(args,dict): return None, ['arguments_not_object']
    issues=[]
    if set(args)-ALLOWED_ARGS: issues.append('unknown_arguments')
    q=args.get('query',args.get('q'))
    if not isinstance(q,str) or not q.strip(): issues.append('missing_or_invalid_query')
    if 'query' in args and 'q' in args and args['query']!=args['q']: issues.append('conflicting_query_keys')
    out={'q':q,'source':args.get('source',contract['default_source']),
         'page':args.get('page',contract['page']),'limit':args.get('limit',contract['default_limit'])}
    if out['source'] not in ['auto','human','veterinary','mixed']: issues.append('invalid_source')
    for field in ['limit','page']:
        if type(out[field]) is not int or out[field]<1: issues.append('invalid_'+field)
    for field in ['dosage','forme','voie']:
        v=args.get(field)
        if v is not None and not isinstance(v,str): issues.append('invalid_'+field)
        out[field]=v
    return (out if not issues else None),issues

EVIDENCE_FIELDS=['type','cis','num','denomination','nom','forme_pharma','forme_pharmaceutique',
                 'voies_admin','voie','especes','commercialisation','etat_commercialisation','statut_amm',
                 'compositions','presentations','substances','atc','atc_code','generiques','generic_groups',
                 'document_text','evidence_truncated']

def clean_evidence(doc):
    """Only source evidence, not a search engine's claims about matching or confidence."""
    return {k:doc[k] for k in EVIDENCE_FIELDS if k in doc}

def parse_historical(row):
    text=row.get('response')
    if text is None: return {'parse_status':'missing','results':[]}
    if row.get('outcome')=='error': return {'parse_status':'error','results':[]}
    if row.get('format')=='json':
        try:
            body=json.loads(text)
            data=body.get('data',body.get('results',[])) if isinstance(body,dict) else body
            if not isinstance(data,list): return {'parse_status':'unsupported_json','results':[]}
            if not all(isinstance(x,dict) for x in data): return {'parse_status':'unsupported_json','results':[]}
            return {'parse_status':'ok','results':[clean_evidence(d) for d in data]}
        except (ValueError,TypeError): return {'parse_status':'invalid_json','results':[]}
    if row.get('outcome')=='empty': return {'parse_status':'ok','results':[]}
    # Parse independent blocks. Do not treat arbitrary repeated CIS references as candidates.
    heads=list(re.finditer(r'^##\s+\d+\.\s+(.+?)\s+[—–-]\s+(CIS|NUM)\s+(\d{7,8})\s*$',text,re.M))
    docs=[]
    for i,m in enumerate(heads):
        block=text[m.end(): heads[i+1].start() if i+1<len(heads) else len(text)]
        lines=[l for l in block.splitlines() if not re.match(r'^-\s*(Match|Critères|Criteres|Fiche):',l,re.I)]
        docs.append({'type':'medicament' if m.group(2)=='CIS' else 'medicament_veterinaire',
                     ('cis' if m.group(2)=='CIS' else 'num'):m.group(3),
                     ('denomination' if m.group(2)=='CIS' else 'nom'):m.group(1),
                     'document_text':'\n'.join(lines).strip()})
    return {'parse_status':'ok' if docs else 'unsupported_markdown','results':docs}


def prepare(a):
    out=Path(a.out);out.mkdir(parents=True,exist_ok=True);os.chmod(out,0o700)
    if (out/'manifest.json').exists() and not a.force:
        raise ValueError('Output already exists. Use a new directory; --force deliberately invalidates the frozen split.')
    contract=json.loads(Path(a.contract).read_text())
    rows=list(load_jsonl(a.calls)); key_counts=collections.Counter(r.get('tool_call_id') for r in rows)
    if None in key_counts or any(v>1 for v in key_counts.values()): raise ValueError('Missing or duplicate tool_call_id')
    summary=json.loads(Path(a.summary).read_text()) if a.summary else None
    if summary and summary.get('total_calls')!=len(rows): raise ValueError('summary total mismatch')
    if summary:
        for field,src in [('by_tool','tool'),('by_outcome','outcome')]:
            if dict(collections.Counter(r.get(src) for r in rows))!=summary.get(field):
                raise ValueError('summary mismatch: '+field)
    index_check=None
    if a.index:
        with open(a.index,encoding='utf-8',newline='') as f: index=list(csv.DictReader(f,delimiter='\t'))
        if collections.Counter(r['tool_call_id'] for r in index)!=key_counts: raise ValueError('TSV ID set mismatch')
        index_check={'rows':len(index),'id_set_equal':True}
    salt=secrets.token_hex(32)
    pseud=lambda kind,x:hashlib.sha256((salt+'\0'+kind+'\0'+str(x)).encode()).hexdigest()[:24]
    requests={};members={};calls=[];excluded=[];hist=[];context=[]
    for row in rows:
        call_id=pseud('call',row['tool_call_id'])
        if row['tool']!='bdpm_search':
            excluded.append({'call_id':call_id,'reason':'availability_separate_temporal_task','historical_outcome':row['outcome']})
            continue
        replay,issues=validate_args(row['args'],contract)
        if replay is None:
            excluded.append({'call_id':call_id,'reason':'invalid_arguments','issues':issues,'historical_outcome':row['outcome']})
            continue
        rid='req_'+digest(row['args'])[:20] # no silent correction of the original arguments
        if rid not in requests:
            requests[rid]={'request_id':rid,'tool':'bdpm_search','original_args':row['args'],'replay':replay,
                           'weight_calls':0,'historical_outcomes':{},'months':{},'models':{},
                           'tags':[],'privacy_flags':pii_flags(canonical(row['args']))}
            members[rid]=[]
        r=requests[rid];r['weight_calls']+=1
        for field,value in [('historical_outcomes',row['outcome']),('months',str(row.get('ts') or row.get('log_file_date') or '')[:7]),('models',row.get('model') or 'unknown')]:
            r[field][value]=r[field].get(value,0)+1
        members[rid].append(row)
        calls.append({'call_id':call_id,'request_id':rid,'historical_outcome':row['outcome'],
                      'model':row.get('model'),'month':str(row.get('ts') or row.get('log_file_date') or '')[:7],
                      'run_link':row.get('run_link')})
        h=parse_historical(row)
        expected=row.get('n_results')
        if h['parse_status']=='ok' and type(expected) is int and expected!=len(h['results']):h['parse_status']='count_mismatch'
        hist.append({'call_id':call_id,'request_id':rid,'system':'HISTORICAL_NOT_ORACLE',
                     'snapshot_id':'historical_unknown','outcome':row['outcome'],'format':row.get('format'),
                     'n_results_reported':expected,'n_total_reported':row.get('n_total'),**h})
        context.append({'call_id':call_id,'request_id':rid,'user_question':row.get('user_question'),
                        'args':row['args'],'run_link':row.get('run_link'),
                        'context_confidence':'heuristic_last_message_not_complete_conversation',
                        'privacy_flags':pii_flags(row.get('user_question'))})
    if not requests:raise ValueError('No replayable search requests in this extraction')
    ids=sorted(requests);d=DSU(len(ids));seen={}
    for i,rid in enumerate(ids):
        for row in members[rid]:
            ks=[('query',norm(row['args'].get('query',row['args'].get('q'))))]
            if row.get('user_question'):ks.append(('question',norm(row['user_question'])))
            if row.get('run_link')=='exact' and row.get('chat_id'):
                ks.append(('exact_chat',str(row['chat_id'])))
            for k in ks:
                if k in seen:d.union(i,seen[k])
                else:seen[k]=i
    components=collections.defaultdict(list)
    for i,rid in enumerate(ids):components[d.find(i)].append(rid)
    for comp in components.values():
        gid='group_'+digest(sorted(comp))[:20]
        f=int(hashlib.sha256((a.seed+gid).encode()).hexdigest()[:12],16)/16**12
        split='development' if f<0.6 else 'calibration' if f<0.8 else 'test_locked'
        for rid in comp:
            r=requests[rid];r['leakage_group']=gid;r['split']=split
            tags=[];q=r['replay']['q']
            if any(r['replay'].get(k) for k in ['forme','voie','dosage']):tags.append('explicit_criteria')
            if re.search(r'\d+(?:[.,]\d+)?\s*(?:mg|mcg|µg|g|ml|ui)\b',q,re.I):tags.append('dose_in_query')
            if re.fullmatch(r'\d{6,14}',q.strip()):tags.append('numeric_identifier')
            if re.search(r'\b(sans|non|pas|ni)\b',canonical(r['original_args']),re.I):tags.append('negation_or_qualifier')
            if r['historical_outcomes'].get('empty'):tags.append('historically_empty')
            if not tags:tags=['plain_query']
            r['tags']=tags
    reqs=[requests[rid] for rid in ids]
    for c in calls:c.update(split=requests[c['request_id']]['split'],leakage_group=requests[c['request_id']]['leakage_group'])
    for c in context:c.update(split=requests[c['request_id']]['split'])
    # Balanced calibration set for judging quality, not an unbiased performance estimator.
    calibration=[r for r in reqs if r['split']=='calibration']
    strata=collections.defaultdict(list)
    for r in calibration:strata[('historically_empty' in r['tags'],'explicit_criteria' in r['tags'])].append(r)
    for v in strata.values():v.sort(key=lambda r:digest([a.seed,r['request_id']]))
    pilot=[]
    while len(pilot)<a.pilot_size and any(strata.values()):
        for key in sorted(strata):
            if strata[key] and len(pilot)<a.pilot_size:pilot.append(strata[key].pop(0)['request_id'])
    outcomes={t:dict(collections.Counter(r['outcome'] for r in rows if r['tool']==t)) for t in sorted(set(r['tool'] for r in rows))}
    eligible_search=[r for r in rows if r['tool']=='bdpm_search']
    completed=sum(r['outcome'] in ['empty','results'] for r in eligible_search)
    split_stats={s:{'requests':sum(r['split']==s for r in reqs),
                    'calls':sum(r['weight_calls'] for r in reqs if r['split']==s),
                    'groups':len(set(r['leakage_group'] for r in reqs if r['split']==s))}
                 for s in ['development','calibration','test_locked']}
    profile={'total_calls':len(rows),'by_tool_outcome':outcomes,'valid_search_calls':len(calls),
             'unique_exact_argument_requests':len(reqs),'search_completed_calls':completed,
             'historical_empty_rate_search_completed':outcomes['bdpm_search'].get('empty',0)/completed if completed else None,
             'exclusions':dict(collections.Counter(e['reason'] for e in excluded)),
             'historical_parse_status':dict(collections.Counter(r['parse_status'] for r in hist)),
             'search_calls_with_explicit_criteria':sum(any(r['args'].get(k) for k in ['forme','dosage','voie']) for r in eligible_search),
             'privacy_flagged_requests':sum(bool(r['privacy_flags']) for r in reqs),
             'user_context_never_in_default_judge_packets':True,'group_count':len(components),
             'largest_group_requests':max(map(len,components.values()),default=0),'split':split_stats,
             'tsv_check':index_check,'pilot_size':len(pilot),'split_seed':a.seed}
    for name,data in [('requests.jsonl',reqs),('calls.jsonl',calls),('excluded.jsonl',excluded),
                      ('historical.jsonl',hist),('context_private.jsonl',context)]:write_jsonl(out/name,data)
    write_json(out/'pilot_request_ids.json',pilot);write_json(out/'contract.json',contract)
    write_json(out/'profile.json',profile)
    manifest={'version':VERSION,'created_at_utc':dt.datetime.now(dt.timezone.utc).isoformat(),
              'preparation_script_sha256':filehash(Path(__file__)),
              'inputs':{Path(p).name:filehash(p) for p in [a.calls,a.summary,a.index] if p},
              'contract_sha256':filehash(out/'contract.json'),'split_seed':a.seed,
              'requests_sha256':filehash(out/'requests.jsonl'),
              'leakage_policy':'connected_components: normalized query across criteria; identical last-user-message; exact-linked chat. No run_candidate.',
              'split_is_not_temporal':True,'unseen_entities_not_guaranteed':True,
              'public_export_allowed':False,'network_calls_performed':0,
              'historical_responses_are_not_ground_truth':True}
    write_json(out/'manifest.json',manifest)
    # Salt is not needed for judging/replay; retained privately to enable local audit trace mapping.
    write_json(out/'identity_private.json',{'salt':salt,'source_call_ids':{pseud('call',r['tool_call_id']):r['tool_call_id'] for r in rows}})
    lines=['# Profil du jeu de production', '',f"{len(rows)} appels ; {len(calls)} appels de recherche rejouables ; {len(reqs)} requêtes à arguments distincts.",
           f"Recherches historiques complètes : {completed}. Réponses vides : {outcomes['bdpm_search'].get('empty',0)} ({format(profile['historical_empty_rate_search_completed'],'.2%') if completed else 'N/A'}).",
           'Ce taux décrit les réponses enregistrées, PAS le taux d’erreur ni la qualité du moteur.', '',
           '| Partition | Requêtes | Appels pondérés | Groupes |','|---|---:|---:|---:|']
    for s,x in split_stats.items():lines.append(f"| {s} | {x['requests']} | {x['calls']} | {x['groups']} |")
    lines+=['',f"Les {sum(r['tool']=='bdpm_availability' for r in rows)} appels de disponibilité constituent une tâche temporelle distincte.",
             'La partition groupe les répétitions, questions identiques et conversations reliées exactement (lien lui-même heuristique).',
             'Elle ne garantit pas des familles de médicaments inédites. Les dates anciennes sont approximatives.',
             'Le défaut limit=10/source=auto doit être confirmé dans le wrapper du tool, avant la campagne finale.',
             'Aucun appel à un moteur actuel ni à un service LLM n’a été effectué par prepare.',
             'Les journaux, requêtes, questions et artefacts détaillés sont privés. Les regex ne garantissent PAS l’anonymisation.']
    (out/'PROFILE.md').write_text('\n'.join(lines)+'\n');os.chmod(out/'PROFILE.md',0o600)
    print(json.dumps(profile,ensure_ascii=False,indent=2))


def select_requests(a):
    data=Path(a.data);manifest=json.loads((data/'manifest.json').read_text())
    if filehash(data/'requests.jsonl')!=manifest['requests_sha256']:raise ValueError('Frozen request file has changed')
    reqs=list(load_jsonl(data/'requests.jsonl'))
    if a.split=='test_locked' and not a.unlock_test:raise ValueError('Locked test requires --unlock-test after freezing code, data snapshot and judge configuration')
    selected=[r for r in reqs if r['split']==a.split]
    if getattr(a,'pilot',False):
        if a.split!='calibration':raise ValueError('--pilot is calibration only')
        ids=set(json.loads((data/'pilot_request_ids.json').read_text()));selected=[r for r in selected if r['request_id'] in ids]
    return selected

GRADE_SCHEMA={
 'type':'object','additionalProperties':False,'required':['scope','query_issue','candidates'],
 'properties':{
  'scope':{'type':'string','enum':['identification','relation_lookup','ambiguous','clinical_out_of_scope','other_out_of_scope','unknown']},
  'query_issue':{'type':['string','null']},
  'candidates':{'type':'array','items':{
   'type':'object','additionalProperties':False,
   'required':['candidate_id','grade','critical_mismatch','review_required','criteria','evidence','reason'],
   'properties':{
    'candidate_id':{'type':'string'},'grade':{'type':['integer','null'],'enum':[0,1,2,3,None]},
    'critical_mismatch':{'type':'boolean'},'review_required':{'type':'boolean'},
    'criteria':{'type':'array','items':{'type':'object','additionalProperties':False,'required':['name','status'],
               'properties':{'name':{'type':'string'},'status':{'type':'string','enum':['matched','contradicted','unknown','not_requested']}}}},
    'evidence':{'type':'array','items':{'type':'object','additionalProperties':False,'required':['field','quote'],
               'properties':{'field':{'type':'string'},'quote':{'type':'string'}}}},
    'reason':{'type':'string'}
   }}}
 }}


def candidate_key(doc):
    if doc.get('type')=='medicament_veterinaire' or doc.get('num'):
        return 'anmv:'+str(doc.get('num'))
    if doc.get('cis'):return 'bdpm:'+str(doc['cis'])
    raise ValueError('Candidate without a stable CIS/ANMV identifier')


def export_packets(a):
    if not 1<=a.top_k<=10 or a.chunk_size<1 or not 0<=a.reverse_fraction<=1:raise ValueError('Invalid packet bounds')
    reqs=select_requests(a);by_req={r['request_id']:r for r in reqs};systems=[s.strip() for s in a.systems.split(',')]
    if len(systems)<2:raise ValueError('Comparison requires at least two systems')
    runs={};snapshots=set();seen_keys=set()
    for path in a.runs:
        side=Path(str(path)+'.manifest.json')
        if not side.exists():raise ValueError('Missing replay manifest: '+str(side))
        m=json.loads(side.read_text())
        if m.get('requests_sha256')!=filehash(Path(a.data)/'requests.jsonl'):raise ValueError('Replay belongs to another request freeze')
        if m.get('missing_vet'):raise ValueError('Incomplete veterinary corpus: not eligible for cross-system evaluation')
        snapshots.add(m['snapshot_id'])
        if m.get('results_sha256')!=filehash(path):raise ValueError('Replay output fingerprint mismatch')
        for row in load_jsonl(path):
            if row['request_id'] not in by_req or row['system'] not in systems:continue
            k=(row['request_id'],row['system'])
            if k in seen_keys:raise ValueError('Duplicate replay key '+str(k))
            seen_keys.add(k);runs[k]=row
    if len(snapshots)!=1:raise ValueError('Cannot pool systems evaluated on different snapshots')
    out=Path(a.out);out.mkdir(parents=True,exist_ok=True);packets=[];mapping=[];failures=[]
    for req in reqs:
        rid=req['request_id'];pool={};ranking={};invalid=False
        for system in systems:
            row=runs.get((rid,system))
            if row is None or row.get('status')!='ok':
                failures.append({'request_id':rid,'system':system,'reason':'missing_or_failed_replay'});invalid=True;continue
            ranked=[]
            for doc in row['results'][:a.top_k]:
                key=candidate_key(doc);e=clean_evidence(doc)
                if key in pool and canonical(pool[key])!=canonical(e):
                    raise ValueError('Conflicting candidate evidence across same-snapshot systems: '+key)
                pool[key]=e;ranked.append(key)
            if len(set(ranked))!=len(ranked):raise ValueError('Duplicate result identity in ranking')
            ranking[system]=ranked
        if invalid:continue
        items=[{'candidate_id':'cand_'+digest([rid,k])[:18],'evidence':v} for k,v in pool.items()]
        key_id={k:'cand_'+digest([rid,k])[:18] for k in pool}
        mapping.append({'request_id':rid,'leakage_group':req['leakage_group'],'weight_calls':req['weight_calls'],
                        'split':req['split'],'evaluation_k':min(a.top_k, req['replay']['limit']), 'rankings':{s:[key_id[x] for x in r] for s,r in ranking.items()},
                        'all_systems_empty':not items})
        random.Random(digest([a.seed,rid])).shuffle(items)
        # Same pool is shared by all systems, no ranking/model/matching metadata shown.
        chunks=[items[i:i+a.chunk_size] for i in range(0,len(items),a.chunk_size)] or [[]]
        for ci,chunk in enumerate(chunks):
            base={'task':'retrieval_relevance_v1','query':scrub(req['replay']['q']),
                  'criteria':{k:scrub(req['replay'][k]) if req['replay'][k] else None for k in ['dosage','forme','voie']},
                  'source':req['replay']['source'],'pool_is_not_complete_corpus':True,
                  'snapshot_id':next(iter(snapshots)),'candidates':chunk}
            pid='packet_'+digest([rid,ci,base])[:24]
            packets.append({'packet_id':pid,'request_id':rid,'replica':0,'chunk':ci,'payload':base})
            if int(digest([rid,ci])[:8],16)/16**8<a.reverse_fraction and len(chunk)>1:
                rev={**base,'candidates':list(reversed(chunk))}
                packets.append({'packet_id':pid+'_reverse','request_id':rid,'replica':1,'chunk':ci,'payload':rev})
    write_jsonl(out/'packets.jsonl',packets);write_jsonl(out/'mapping_private.jsonl',mapping)
    write_jsonl(out/'replay_failures.jsonl',failures);write_json(out/'judge_schema.json',GRADE_SCHEMA)
    prompt=(ROOT/'prompts/retrieval_judge.md').read_text()
    (out/'judge_prompt.md').write_text(prompt)
    stats={'snapshot_id':next(iter(snapshots)),'systems':systems,'split':a.split,'top_k':a.top_k,
           'requests_selected':len(reqs),'requests_complete':len(mapping),'replay_failures':len(failures),
           'all_systems_empty_unresolved':sum(r['all_systems_empty'] for r in mapping),
           'packets':len(packets),'candidate_judgments':sum(len(p['payload']['candidates']) for p in packets),
           'raw_context_included':False,'engine_names_and_scores_hidden':True,'network_calls_performed':0,
           'packets_sha256':filehash(out/'packets.jsonl'),'mapping_sha256':filehash(out/'mapping_private.jsonl'),
           'prompt_sha256':filehash(out/'judge_prompt.md'),'schema_sha256':filehash(out/'judge_schema.json'),
           'estimated_input_tokens_rough_chars_div_3':sum((len(canonical(p['payload']))+len(prompt))//3 for p in packets),
           'estimate_is_not_tokenizer_count':True,'remote_requires_explicit_file_hash_approval':True}
    write_json(out/'manifest.json',stats);print(json.dumps(stats,indent=2))


def history_packets(a):
    """Judge calibration against recorded evidence only. Never a current-engine comparison."""
    reqs=select_requests(a);by_req={r['request_id']:r for r in reqs}
    selected={}
    for h in load_jsonl(Path(a.data)/'historical.jsonl'):
        if h['request_id'] in by_req and h['parse_status']=='ok' and h['request_id'] not in selected:
            selected[h['request_id']]=h  # first observed complete response, not claimed latest
    packets=[];mapping=[]
    for rid,h in selected.items():
        req=by_req[rid];items=[];ranking=[]
        for doc in h['results'][:10]:
            cid='cand_'+digest([rid,candidate_key(doc)])[:18]
            if cid in ranking:continue
            ranking.append(cid);items.append({'candidate_id':cid,'evidence':clean_evidence(doc)})
        random.Random(digest(['history-calibration',rid])).shuffle(items)
        base={'task':'retrieval_relevance_v1','query':scrub(req['replay']['q']),
              'criteria':{k:scrub(req['replay'][k]) if req['replay'][k] else None for k in ['dosage','forme','voie']},
              'source':req['replay']['source'],'pool_is_not_complete_corpus':True,
              'snapshot_id':'historical_unknown_do_not_infer_current_status','candidates':items}
        pid='history_'+digest([rid,base])[:24]
        packets.append({'packet_id':pid,'request_id':rid,'replica':0,'chunk':0,'payload':base})
        if len(items)>1 and int(digest(rid)[:8],16)/16**8<.2:
            packets.append({'packet_id':pid+'_reverse','request_id':rid,'replica':1,'chunk':0,
                            'payload':{**base,'candidates':list(reversed(items))}})
        mapping.append({'request_id':rid,'leakage_group':req['leakage_group'],'weight_calls':req['weight_calls'],
                        'split':req['split'],'evaluation_k':min(10,req['replay']['limit']),
                        'rankings':{'HISTORICAL_NOT_ORACLE':ranking},'all_systems_empty':not items,
                        'historical_call_id':h['call_id']})
    out=Path(a.out);out.mkdir(parents=True,exist_ok=True)
    write_jsonl(out/'packets.jsonl',packets);write_jsonl(out/'mapping_private.jsonl',mapping)
    write_json(out/'judge_schema.json',GRADE_SCHEMA)
    (out/'judge_prompt.md').write_text((ROOT/'prompts/retrieval_judge.md').read_text())
    write_json(out/'manifest.json',{'purpose':'JUDGE_CALIBRATION_ONLY_NOT_ENGINE_COMPARISON',
       'systems':['HISTORICAL_NOT_ORACLE'],'split':a.split,'requests_selected':len(reqs),
       'requests_complete':len(mapping),'replay_failures':0,'top_k':10,
       'all_systems_empty_unresolved':sum(r['all_systems_empty'] for r in mapping),
       'packets':len(packets),'candidate_judgments':sum(len(p['payload']['candidates']) for p in packets),
       'raw_context_included':False,'network_calls_performed':0,
       'packets_sha256':filehash(out/'packets.jsonl'),'mapping_sha256':filehash(out/'mapping_private.jsonl'),
       'prompt_sha256':filehash(out/'judge_prompt.md'),'schema_sha256':filehash(out/'judge_schema.json'),
       'warning':'Recorded evidence only; unknown historical snapshots; first complete response, not necessarily latest. No ranking comparison with current systems.'})
    print(canonical({'status':'calibration_packets_ready','requests':len(mapping),'packets':len(packets),
                     'candidates':sum(len(p['payload']['candidates']) for p in packets),'LLM_called':False}))


CONTEXT_SCHEMA={
 'type':'object','additionalProperties':False,
 'required':['alignment','lost_constraints','added_constraints','reason','review_required'],
 'properties':{'alignment':{'type':'string','enum':['aligned','partially_aligned','contradicted','unknown']},
  'lost_constraints':{'type':'array','items':{'type':'string'}},
  'added_constraints':{'type':'array','items':{'type':'string'}},
  'reason':{'type':'string'},'review_required':{'type':'boolean'}}}

def context_packets(a):
    if not a.include_user_context:
        raise ValueError('Explicit --include-user-context required: this audit includes possibly sensitive last-user messages')
    selected=select_requests(a);ids={r['request_id'] for r in selected};packets=[]
    for c in load_jsonl(Path(a.data)/'context_private.jsonl'):
        if c['request_id'] not in ids:continue
        payload={'task':'context_alignment_v1','last_user_message':scrub(c['user_question']),
                 'tool_args':{k:scrub(v) if isinstance(v,str) else v for k,v in c['args'].items()},
                 'context_limit':'Only last user message; previous conversation unavailable. Association is heuristic.'}
        packets.append({'packet_id':'context_'+c['call_id'],'request_id':c['request_id'],
                        'replica':0,'chunk':0,'payload':payload})
    out=Path(a.out);out.mkdir(parents=True,exist_ok=True)
    write_jsonl(out/'packets.jsonl',packets);write_json(out/'judge_schema.json',CONTEXT_SCHEMA)
    (out/'judge_prompt.md').write_text((ROOT/'prompts/context_audit.md').read_text())
    write_json(out/'manifest.json',{'purpose':'CONTEXT_ALIGNMENT_NOT_ENGINE_QUALITY','split':a.split,
       'packets':len(packets),'raw_context_included':True,'automatic_scrubbing_not_anonymization':True,
       'packets_sha256':filehash(out/'packets.jsonl'),'prompt_sha256':filehash(out/'judge_prompt.md'),
       'schema_sha256':filehash(out/'judge_schema.json'),'network_calls_performed':0})
    print(canonical({'packets':len(packets),'sensitive_context_included':True,'network_calls_performed':0}))

def validate_context(obj):
    if not isinstance(obj,dict) or set(obj)!=set(CONTEXT_SCHEMA['required']):raise ValueError('Context judgment keys')
    if obj['alignment'] not in CONTEXT_SCHEMA['properties']['alignment']['enum']:raise ValueError('Invalid context alignment')
    for field in ['lost_constraints','added_constraints']:
        if not isinstance(obj[field],list) or not all(isinstance(v,str) for v in obj[field]):raise ValueError('Context constraints type')
    if not isinstance(obj['reason'],str) or type(obj['review_required']) is not bool:raise ValueError('Context judgment types')
    return obj

def score_context(a):
    folder=Path(a.packets);m=json.loads((folder/'manifest.json').read_text())
    ps={p['packet_id']:p for p in load_jsonl(folder/'packets.jsonl')}
    if filehash(folder/'packets.jsonl')!=m['packets_sha256']:raise ValueError('Changed packets')
    done={};errors=0
    for r in load_jsonl(a.judgments):
        p=ps.get(r['packet_id'])
        if not p or digest(p['payload'])!=r['payload_sha256'] or r['prompt_sha256']!=m['prompt_sha256']:raise ValueError('Stale context judgment')
        if r['status']!='ok':errors+=1;continue
        done[r['packet_id']]=validate_context(r['judgment'])
    counts=dict(collections.Counter(v['alignment'] for v in done.values()))
    report={'task':'context_alignment','labels_are_provisional':True,'packets':len(ps),'completed':len(done),
            'alignment_counts':counts,'error_attempts':errors,
            'review_required':sum(v['review_required'] for v in done.values()),
            'note':'Not an engine ranking score. Last-message context may be incomplete or heuristically attached.'}
    out=Path(a.out);out.mkdir(parents=True,exist_ok=True);write_json(out/'report.json',report)
    print(json.dumps(report,ensure_ascii=False,indent=2))


def field_value(obj,path):
    value=obj
    parts=path.replace('[','.').replace(']','').split('.')
    if parts and parts[0]=='evidence':parts=parts[1:]
    for part in parts:
        if isinstance(value,list):value=value[int(part)]
        elif isinstance(value,dict):value=value[part]
        else:raise KeyError(path)
    return value


def validate_judgment(obj,payload):
    if not isinstance(obj,dict) or set(obj)!=set(GRADE_SCHEMA['required']):raise ValueError('Invalid judgment keys')
    if obj['scope'] not in GRADE_SCHEMA['properties']['scope']['enum']:raise ValueError('Invalid scope')
    if obj['query_issue'] is not None and not isinstance(obj['query_issue'],str):raise ValueError('query_issue type')
    if not isinstance(obj['candidates'],list):raise ValueError('candidates type')
    expected={c['candidate_id']:c for c in payload['candidates']}
    if len(obj['candidates'])!=len(expected):raise ValueError('Candidate count mismatch')
    seen=set()
    for result in obj['candidates']:
        if set(result)!=set(GRADE_SCHEMA['properties']['candidates']['items']['required']):raise ValueError('Invalid candidate judgment keys')
        cid=result['candidate_id']
        if cid not in expected or cid in seen:raise ValueError('Unknown/duplicate candidate id')
        seen.add(cid)
        g=result['grade']
        if not(g is None or type(g) is int and 0<=g<=3):raise ValueError('Invalid grade')
        for k in ['critical_mismatch','review_required']:
            if type(result[k]) is not bool:raise ValueError('Invalid bool '+k)
        if not isinstance(result['reason'],str):raise ValueError('reason type')
        if not isinstance(result['criteria'],list):raise ValueError('criteria type')
        names=[c.get('name') for c in result['criteria'] if isinstance(c,dict)]
        if len(names)!=len(set(names)):raise ValueError('Duplicate criterion name')
        for name,value in payload.get('criteria',{}).items():
            if value and not any(c.get('name')==name and c.get('status')!='not_requested' for c in result['criteria']):raise ValueError('Explicit criterion not assessed: '+name)
        for c in result['criteria']:
            if set(c)!={'name','status'} or not isinstance(c['name'],str) or c['status'] not in ['matched','contradicted','unknown','not_requested']:raise ValueError('Invalid criterion')
        if g in [2,3] and (result['critical_mismatch'] or any(c['status']=='contradicted' for c in result['criteria'])):raise ValueError('Grade contradicts an explicit mismatch')
        if g==3 and any(c['status']=='unknown' for c in result['criteria']):raise ValueError('Grade 3 with unknown requested criterion')
        ev=result['evidence']
        if not isinstance(ev,list) or (g is not None and not ev):raise ValueError('Non-null grade requires documentary evidence')
        for e in ev:
            if set(e)!={'field','quote'} or not isinstance(e['quote'],str) or not e['quote']:raise ValueError('Invalid evidence')
            try:v=field_value(expected[cid]['evidence'],e['field'])
            except Exception as ex:raise ValueError('Unknown evidence path') from ex
            if e['quote'] not in (v if isinstance(v,str) else canonical(v)):raise ValueError('Evidence quote is not verbatim')
    return obj


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):raise ValueError('Redirect refused: protect credentials and private payloads')


def judge(a):
    if a.max_requests is not None and a.max_requests<0:raise ValueError('max-requests must be non-negative')
    folder=Path(a.packets);manifest=json.loads((folder/'manifest.json').read_text())
    for name,key in [('packets.jsonl','packets_sha256'),('judge_prompt.md','prompt_sha256'),('judge_schema.json','schema_sha256')]:
        if filehash(folder/name)!=manifest[key]:raise ValueError('Judge artifact changed after freeze: '+name)
    uri=urllib.parse.urlparse(a.base_url)
    if uri.username or uri.password or uri.query or uri.fragment:raise ValueError('Credentials/query/fragment prohibited in base URL')
    local=uri.hostname in ['localhost','127.0.0.1','::1']
    if not local and (not a.allow_remote or a.reviewed_packets_sha256!=manifest['packets_sha256']):
        raise ValueError('Remote transfer blocked. Review packets and provide --allow-remote --reviewed-packets-sha256 EXACT_HASH.')
    if uri.scheme!='https' and not(local and uri.scheme=='http'):raise ValueError('HTTPS required except loopback')
    model=a.model
    if not model:raise ValueError('Set an explicit judge model identifier; no implicit latest model')
    packets=list(load_jsonl(folder/'packets.jsonl'))
    prompt=(folder/'judge_prompt.md').read_text();schema=json.loads((folder/'judge_schema.json').read_text())
    run_key=digest([model,a.base_url,manifest['packets_sha256'],manifest['prompt_sha256'],manifest['schema_sha256'],a.temperature,a.structured])
    done=set();output=Path(a.out);output.parent.mkdir(parents=True,exist_ok=True)
    if output.exists():
        for r in load_jsonl(output):
            if r.get('run_key')!=run_key:raise ValueError('Existing judgments belong to another model/configuration. Use another output.')
            if r.get('status')=='ok':done.add((r['packet_id'],r['payload_sha256']))
    pending=[p for p in packets if (p['packet_id'],digest(p['payload'])) not in done]
    if a.max_requests is not None:pending=pending[:a.max_requests]
    print(canonical({'pending_requests':len(pending),'remote':not local,'model':model,'dry_run':not a.execute}))
    if not a.execute:return
    token=os.getenv(a.key_env,'')
    if not local and not token:raise ValueError('Missing API key environment variable '+a.key_env)
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
    usage_total={'prompt_tokens':0,'completion_tokens':0}
    with output.open('a',encoding='utf-8') as f:
        os.chmod(output,0o600)
        for p in pending:
            body={'model':model,'messages':[{'role':'system','content':prompt},
                    {'role':'user','content':canonical(p['payload'])}],
                  'max_completion_tokens':a.max_output_tokens}
            if a.temperature is not None:body['temperature']=a.temperature
            if a.structured:
                body['response_format']={'type':'json_schema','json_schema':{'name':'retrieval_grade','strict':True,'schema':schema}}
            else:
                body['messages'][0]['content']+='\nJSON schema: '+canonical(schema)
            record={'packet_id':p['packet_id'],'request_id':p['request_id'],'replica':p['replica'],
                    'chunk':p['chunk'],'payload_sha256':digest(p['payload']),'model':model,
                    'run_key':run_key,'prompt_sha256':manifest['prompt_sha256'],
                    'created_at_utc':dt.datetime.now(dt.timezone.utc).isoformat()}
            try:
                for attempt in range(3):
                    try:
                        # A forwarding proxy on loopback (anthropic_schema_shim.py) checks this header
                        # against the hash approved at its start: the remote-transfer approval cannot be
                        # bypassed by pointing --base-url at 127.0.0.1.
                        req=urllib.request.Request(a.base_url.rstrip('/')+'/chat/completions',
                             data=canonical(body).encode(),headers={'Content-Type':'application/json',
                             **({'Authorization':'Bearer '+token} if token else {}),
                             **({'X-Bench-Reviewed-Packets-Sha256':a.reviewed_packets_sha256} if a.reviewed_packets_sha256 else {})})
                        with opener.open(req,timeout=a.timeout) as resp:response=json.load(resp)
                        break
                    except urllib.error.HTTPError as e:
                        if e.code not in [429,500,502,503,504] or attempt==2:raise
                        time.sleep(2**attempt)
                # The model that served the request must be the one requested: a provider
                # fallback or reroute would silently change the judge. Mismatch -> error, never a grade.
                served=response.get('model')
                if served!=model:raise ValueError(f'Served model mismatch: requested {model}, served {served}')
                record['served_model']=served
                choice=response['choices'][0];msg=choice['message']
                if msg.get('refusal'):raise ValueError('Judge refused')
                if choice.get('finish_reason')!='stop':raise ValueError('Non-complete response: '+str(choice.get('finish_reason')))
                content=msg['content'];obj=json.loads(content)
                record.update(status='ok',judgment=(validate_context(obj) if p['payload'].get('task')=='context_alignment_v1' else validate_judgment(obj,p['payload'])),
                              usage=response.get('usage',{}),response_id=response.get('id'))
                for k in usage_total:usage_total[k]+=response.get('usage',{}).get(k,0)
            except Exception as e:
                # Do not copy response bodies / headers: they may echo sensitive data or credentials.
                record.update(status='error',error_type=type(e).__name__,error_message=str(e)[:180])
            f.write(canonical(record)+'\n');f.flush()
    write_json(str(output)+'.manifest.json',{'run_key':run_key,'model':model,'endpoint_host':uri.hostname,
          'packets_sha256':manifest['packets_sha256'],'prompt_sha256':manifest['prompt_sha256'],
          'usage_this_invocation':usage_total,'results_sha256':filehash(output),
          'note':'Repeated requests may incur charges. Not a clinical validation.'})


def collect_grades(path,packets,prompt_sha256):
    packet_map={p['packet_id']:p for p in packets};latest={};errors=[]
    for row in load_jsonl(path):
        pid=row.get('packet_id');p=packet_map.get(pid)
        if row.get('prompt_sha256')!=prompt_sha256:raise ValueError('Judgment belongs to another rubric')
        if p is None:raise ValueError('Judgment for unknown packet')
        if row.get('payload_sha256')!=digest(p['payload']):raise ValueError('Stale payload judgment')
        if row.get('status')=='ok':
            validate_judgment(row['judgment'],p['payload']);latest[pid]=row
        else:errors.append(pid)
    grades=collections.defaultdict(dict);scopes=collections.defaultdict(set);review=[];reverse=[]
    for pid,row in latest.items():
        p=packet_map[pid]
        if p['replica']!=0:continue
        scopes[p['request_id']].add(row['judgment']['scope'])
        for j in row['judgment']['candidates']:
            grades[p['request_id']][j['candidate_id']]=j
            if j['review_required']:review.append({'packet_id':pid,'candidate_id':j['candidate_id'],'reason':'judge_requests_review'})
        reversed_row=latest.get(pid+'_reverse')
        if reversed_row:
            rev={r['candidate_id']:r for r in reversed_row['judgment']['candidates']}
            for j in row['judgment']['candidates']:
                if j['grade']!=rev[j['candidate_id']]['grade']:
                    reverse.append({'packet_id':pid,'candidate_id':j['candidate_id'],'reason':'order_disagreement'})
    return grades,scopes,review,reverse,len(errors),len(latest)


def metrics_for(ranking,grades,pool,k=10):
    gs=[grades[c]['grade'] for c in ranking]
    k=min(k,10)
    dcg=lambda a:sum((2**g-1)/math.log2(i+2) for i,g in enumerate(a))
    denominator=dcg(sorted((grades[c]['grade'] for c in pool),reverse=True)[:k])
    return {'top1_grade3':float(bool(gs) and gs[0]==3),
            'hit5_grade2plus':float(any(g>=2 for g in gs[:5])),
            'mrr10_grade2plus':next((1/(i+1) for i,g in enumerate(gs[:10]) if g>=2),0),
            'ndcg_requested_k_pooled':dcg(gs[:k])/denominator if denominator else 0,
            'critical_mismatch_top1':float(bool(ranking) and grades[ranking[0]]['critical_mismatch']),
            'empty':float(not ranking)}


def cluster_bootstrap(rows,metric,sysa,sysb,seed=42,n=1000):
    groups=collections.defaultdict(list)
    for r in rows:groups[r['leakage_group']].append(r)
    if not groups:return None
    group_sums=[]
    for rs in groups.values():
        group_sums.append((sum((r['scores'][sysa][metric]-r['scores'][sysb][metric])*r['weight_calls'] for r in rs),sum(r['weight_calls'] for r in rs)))
    rng=random.Random(seed);vals=[]
    for _ in range(n):
        sampled=[rng.choice(group_sums) for _ in group_sums]
        vals.append(sum(x for x,w in sampled)/sum(w for x,w in sampled))
    vals.sort();point=sum(x for x,w in group_sums)/sum(w for x,w in group_sums)
    return {'delta':point,'ci95_cluster_percentile':[vals[int(n*.025)],vals[min(n-1,int(n*.975))]],
            'groups':len(groups),'bootstrap_replicates':n,'descriptive_only_if_few_groups':len(groups)<20,
            'note':'Sampling uncertainty conditional on LLM labels; excludes judge/model bias.'}


def score(a):
    if json.loads((Path(a.packets)/'manifest.json').read_text()).get('purpose')=='CONTEXT_ALIGNMENT_NOT_ENGINE_QUALITY':return score_context(a)
    if a.bootstrap<100:raise ValueError('At least 100 bootstrap replicates required')
    folder=Path(a.packets);manifest=json.loads((folder/'manifest.json').read_text())
    packets=list(load_jsonl(folder/'packets.jsonl'));mapping=list(load_jsonl(folder/'mapping_private.jsonl'))
    if filehash(folder/'packets.jsonl')!=manifest['packets_sha256']:raise ValueError('Packets hash mismatch')
    if filehash(folder/'mapping_private.jsonl')!=manifest['mapping_sha256']:raise ValueError('Mapping hash mismatch')
    grades,scopes,review,reverse,errors,completed=collect_grades(a.judgments,packets,manifest['prompt_sha256'])
    if a.secondary:
        g2,s2,rev2,order2,err2,completed2=collect_grades(a.secondary,packets,manifest['prompt_sha256'])
        for rid,gs in grades.items():
            for cid,g in gs.items():
                other=g2.get(rid,{}).get(cid)
                if not other or other['grade']!=g['grade'] or other['critical_mismatch']!=g['critical_mismatch']:
                    review.append({'request_id':rid,'candidate_id':cid,'reason':'second_judge_disagreement_or_missing'})
                    g['grade']=None
            if scopes[rid]!=s2.get(rid):scopes[rid].add('unknown')
    order_bad={(r['packet_id'],r['candidate_id']) for r in reverse}
    for pid,cid in order_bad:
        p=next(p for p in packets if p['packet_id']==pid)
        grades[p['request_id']][cid]['grade']=None
    rows=[];excluded=collections.Counter();systems=manifest['systems']
    for r in mapping:
        rid=r['request_id'];gs=grades.get(rid,{})
        if r['all_systems_empty']:excluded['all_empty_cannot_infer_correct_abstention']+=1;continue
        if scopes.get(rid) not in [{'identification'},{'relation_lookup'}]:excluded['scope_ambiguous_outside_or_unjudged']+=1;continue
        pool=set(c for ranking in r['rankings'].values() for c in ranking)
        if any(c not in gs or gs[c]['grade'] is None for c in pool):excluded['incomplete_or_disputed_judgment']+=1;continue
        if not any(gs[c]['grade']>=2 for c in pool):excluded['no_positive_in_pool_unresolved']+=1;continue
        rows.append({**r,'scores':{s:metrics_for(r['rankings'][s],gs,pool,r.get('evaluation_k',10)) for s in systems}})
    metrics={}
    for s in systems:
        metrics[s]={}
        for name in ['top1_grade3','hit5_grade2plus','mrr10_grade2plus','ndcg_requested_k_pooled','critical_mismatch_top1','empty']:
            metrics[s][name]={'macro':statistics.mean(r['scores'][s][name] for r in rows) if rows else None,
              'traffic_weighted':sum(r['scores'][s][name]*r['weight_calls'] for r in rows)/sum(r['weight_calls'] for r in rows) if rows else None}
    comparisons={}
    if systems:
        for s in systems[1:]:
            comparisons[s+'-'+systems[0]]=cluster_bootstrap(rows,'ndcg_requested_k_pooled',s,systems[0],n=a.bootstrap)
    contradiction_audit={};replay_diagnostics={}
    for system in systems:
        checked=0;bad=0;weighted_checked=0;weighted_bad=0
        for row in mapping:
            ranking=row['rankings'][system]
            if not ranking:continue
            j=grades.get(row['request_id'],{}).get(ranking[0])
            if not j or j['grade'] is None:continue
            checked+=1;weighted_checked+=row['weight_calls']
            if j['critical_mismatch']:bad+=1;weighted_bad+=row['weight_calls']
        contradiction_audit[system]={'judged_nonempty_top1':checked,'explicit_contradictions':bad,
          'weighted_judged_nonempty_top1':weighted_checked,'weighted_explicit_contradictions':weighted_bad}
        replay_diagnostics[system]={'requests':len(mapping),'empty_requests':sum(not r['rankings'][system] for r in mapping),
          'traffic_calls':sum(r['weight_calls'] for r in mapping),
          'empty_traffic_calls':sum(r['weight_calls'] for r in mapping if not r['rankings'][system])}
    report={'status':'LLM_PROVISIONAL_NOT_GOLD','requests_selected':manifest['requests_selected'],
      'requests_with_complete_replay':len(mapping),'requests_rank_scored':len(rows),
      'scored_traffic_calls':sum(r['weight_calls'] for r in rows),'excluded_from_rank_scoring':dict(excluded),
      'replay_failures':manifest['replay_failures'],'judge_completed_packets':completed,'judge_error_records':errors,
      'order_disagreements':len(reverse),'needs_review':len(review),'metrics_on_scored_subset_only':metrics,
      'paired_comparisons':comparisons,'contradiction_audit_all_judged_top1':contradiction_audit,
      'retrieval_diagnostics_all_complete_replays':replay_diagnostics,
      'warnings':['No global Recall: relevance labels come only from pooled top results.',
                  'Historical replies are not ground truth; no historical/current quality mixing.',
                  'All-empty cases require independent corpus evidence before declaring correct abstention.',
                  'Uncertainty intervals exclude systematic judge errors; clinical truth is not evaluated.']}
    out=Path(a.out);out.mkdir(parents=True,exist_ok=True)
    write_json(out/'report.json',report);write_jsonl(out/'case_scores_private.jsonl',rows)
    write_jsonl(out/'review_queue_private.jsonl',review+reverse)
    text=['# Résultats provisoires du juge LLM','',f"{len(rows)} requêtes notées sur {len(mapping)} replays complets.",
          'Les métriques ci-dessous ne valent que pour ce sous-ensemble ; voir la couverture et les exclusions dans report.json.','',
          '| Système | Top-1 strict | Hit@5 | nDCG@min(10,limit) pool |','|---|---:|---:|---:|']
    for s in systems:
        vals=[metrics[s][m]['traffic_weighted'] for m in ['top1_grade3','hit5_grade2plus','ndcg_requested_k_pooled']]
        text.append('| '+s+' | '+' | '.join('N/A' if x is None else f'{x:.3f}' for x in vals)+' |')
    text+=['','Pas de rappel global ni de garantie clinique. Le juge doit être calibré sur un échantillon vérifié indépendamment.']
    (out/'REPORT.md').write_text('\n'.join(text)+'\n')
    print(json.dumps(report,indent=2,ensure_ascii=False))


def main():
    p=argparse.ArgumentParser(description=__doc__);sub=p.add_subparsers(dest='command',required=True)
    x=sub.add_parser('prepare');x.add_argument('--calls',required=True);x.add_argument('--index');x.add_argument('--summary')
    x.add_argument('--contract',default=str(ROOT/'contract.json'));x.add_argument('--out',required=True)
    x.add_argument('--seed',default='bdpm-production-v1-2026-11-13');x.add_argument('--pilot-size',type=int,default=60)
    x.add_argument('--force',action='store_true');x.set_defaults(func=prepare)
    x=sub.add_parser('packets');x.add_argument('--data',required=True);x.add_argument('--runs',nargs='+',required=True)
    x.add_argument('--systems',default='B0,B1,B2');x.add_argument('--split',choices=['development','calibration','test_locked'],default='calibration')
    x.add_argument('--pilot',action='store_true');x.add_argument('--unlock-test',action='store_true')
    x.add_argument('--top-k',type=int,default=10);x.add_argument('--chunk-size',type=int,default=12)
    x.add_argument('--reverse-fraction',type=float,default=.15);x.add_argument('--seed',default='blind-pooling-v1')
    x.add_argument('--out',required=True);x.set_defaults(func=export_packets)
    x=sub.add_parser('history-packets');x.add_argument('--data',required=True)
    x.add_argument('--split',choices=['calibration'],default='calibration')
    x.add_argument('--pilot',action=argparse.BooleanOptionalAction,default=True)
    x.add_argument('--unlock-test',action='store_true');x.add_argument('--out',required=True);x.set_defaults(func=history_packets)
    x=sub.add_parser('context-packets');x.add_argument('--data',required=True)
    x.add_argument('--split',choices=['development','calibration','test_locked'],default='calibration')
    x.add_argument('--pilot',action=argparse.BooleanOptionalAction,default=True)
    x.add_argument('--include-user-context',action='store_true');x.add_argument('--unlock-test',action='store_true')
    x.add_argument('--out',required=True);x.set_defaults(func=context_packets)
    x=sub.add_parser('judge');x.add_argument('--packets',required=True);x.add_argument('--base-url',required=True)
    x.add_argument('--model',required=True);x.add_argument('--key-env',default='JUDGE_API_KEY')
    x.add_argument('--out',required=True);x.add_argument('--max-requests',type=int,default=20)
    x.add_argument('--max-output-tokens',type=int,default=6000);x.add_argument('--temperature',type=float)
    x.add_argument('--timeout',type=int,default=120);x.add_argument('--allow-remote',action='store_true')
    x.add_argument('--reviewed-packets-sha256');x.add_argument('--execute',action='store_true')
    x.add_argument('--structured',action=argparse.BooleanOptionalAction,default=True);x.set_defaults(func=judge)
    x=sub.add_parser('score');x.add_argument('--packets',required=True);x.add_argument('--judgments',required=True)
    x.add_argument('--secondary');x.add_argument('--bootstrap',type=int,default=1000);x.add_argument('--out',required=True);x.set_defaults(func=score)
    a=p.parse_args()
    try:a.func(a)
    except Exception as e:print(f'ERROR: {e}',file=sys.stderr);return 2
    return 0
if __name__=='__main__':raise SystemExit(main())
