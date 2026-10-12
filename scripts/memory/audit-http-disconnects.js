#!/usr/bin/env node
'use strict';

// Local uniquement : BDPM, 1 000 réponses interrompues et 30 cycles HTTP.
// Le GC forcé et les références faibles vérifient la rétention après chaque lot.
const fs = require('node:fs');
const http = require('node:http');
const { setTimeout: delay, setImmediate: nextTurn } = require('node:timers/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
process.env.ENABLE_RATE_LIMIT = 'true';
process.env.RATE_LIMIT_MAX = '100000';
const out = path.resolve(process.env.AUDIT_HTTP_OUT || path.join(root, 'tmp/memory-audit/http-disconnects.json'));
const report = { runtime: process.version, request_batches: [], lifecycles: 30 };
async function sample() {
  await nextTurn(); global.gc(); await nextTurn(); global.gc(); await nextTurn();
  return { memory: process.memoryUsage(), fds: fs.readdirSync('/proc/self/fd').length,
    resources: process.getActiveResourcesInfo().reduce((out,key)=>(out[key]=(out[key]||0)+1,out),{}) };
}
async function abandon(port) {
  return new Promise((resolve, reject) => {
    let received = false;
    const req = http.get({hostname:'127.0.0.1',port,path:'/api/medicaments/specialites?limit=1000',agent:false},res=>{
      res.on('error',()=>{});
      res.once('data',()=> { received = true; res.destroy(); req.destroy(); });
    });
    req.setTimeout(10000, () => req.destroy(new Error('HTTP timeout')));
    req.on('error',reject);
    req.on('close',()=> received ? resolve() : reject(new Error('no response received')));
  });
}
(async()=>{
  if (!global.gc) throw new Error('--expose-gc requis');
  await require(root+'/src/services/dataLoader').loadData();
  const {createApp} = require(root+'/src/app');
  let app=createApp();
  let server=app.listen(0,'127.0.0.1');
  try {
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const port=server.address().port;
  report.baseline=await sample();
  for(let batch=0;batch<4;batch++){
    for(let i=0;i<25;i++)await Promise.all(Array.from({length:10},()=>abandon(port)));
    await delay(50);
    report.request_batches.push({requests:250,...await sample()});
  }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    app.locals.dispose();
  }
  app=null;server=null;
  report.before_lifecycles=await sample();
  const refs=[];
  for(let cycle=0;cycle<report.lifecycles;cycle++){
    await (async()=>{
      const instance=createApp(); const listener=instance.listen(0,'127.0.0.1');
      try {
        await new Promise((resolve, reject) => {
          listener.once('listening', resolve);
          listener.once('error', reject);
        });
        refs.push({app:new WeakRef(instance),server:new WeakRef(listener)});
      } finally {
        listener.closeAllConnections();
        await new Promise(resolve => listener.close(resolve));
        instance.locals.dispose();
      }
    })();
  }
  report.after_lifecycles=await sample();
  report.retained_apps=refs.filter(ref=>ref.app.deref()).length;
  report.retained_servers=refs.filter(ref=>ref.server.deref()).length;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report,null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
