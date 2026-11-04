#!/usr/bin/env node
/**
 * Compare Node vs Bun (stable 1.4.0 + canary) : pic RSS (VmHWM) et RSS plateau.
 *
 * Usage:
 *   node scripts/memory/compare-node-bun.js
 *   RUNS=2 SETTLE_MS=420000 node scripts/memory/compare-node-bun.js
 *   ONLY=bun-1.4.1-canary,a1-bundle,a2-bytecode,a3-compile \\
 *     OUT=tmp/compile-memory-settle7min.json node scripts/memory/compare-node-bun.js
 *
 * Le binaire Bun 1.4.0 baseline est attendu dans tmp/bun-runtimes/1.4.0-baseline/bun
 * (CPU sans AVX2). Le canary est ~/.bun/bin/bun.
 * Variantes compilation (tmp/bun-build/) : a1-bundle, a2-bytecode, a3-compile.
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const CHILD = path.join(__dirname, 'load-and-hold.js');
const RUNS = Math.max(1, parseInt(process.env.RUNS || '2', 10));
const SETTLE_MS = parseInt(process.env.SETTLE_MS || '420000', 10);
const VET_GAP_MS = parseInt(process.env.VET_GAP_MS || '5000', 10);
const POST_GC_HOLD_MS = parseInt(process.env.POST_GC_HOLD_MS || '30000', 10);
const WARMUP = process.env.WARMUP !== '0';
const SAMPLE_MS = Math.max(50, parseInt(process.env.SAMPLE_MS || '100', 10));
const SETTLE_SAMPLE_MS = Math.max(200, parseInt(process.env.SETTLE_SAMPLE_MS || '1000', 10));
const OUT =
  process.env.OUT ||
  path.join(
    ROOT,
    'tmp',
    `runtime-memory-${new Date().toISOString().slice(0, 10)}-settle${Math.round(SETTLE_MS / 60000)}min.json`
  );

function kbToMb(kb) {
  return Math.round((kb / 1024) * 10) / 10;
}

function readProc(pid) {
  const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
  const pick = (key) => {
    const m = status.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'));
    return m ? parseInt(m[1], 10) : null;
  };
  let pssKb = null;
  try {
    const rollup = fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
    const m = rollup.match(/^Pss:\\s+(\\d+)/m);
    if (m) pssKb = parseInt(m[1], 10);
  } catch {
    // smaps_rollup parfois indisponible
  }
  return {
    rss_mb: kbToMb(pick('VmRSS') || 0),
    hwm_mb: kbToMb(pick('VmHWM') || 0),
    size_mb: kbToMb(pick('VmSize') || 0),
    data_mb: kbToMb(pick('VmData') || 0),
    anon_mb: pick('RssAnon') != null ? kbToMb(pick('RssAnon')) : null,
    file_mb: pick('RssFile') != null ? kbToMb(pick('RssFile')) : null,
    shmem_mb: pick('RssShmem') != null ? kbToMb(pick('RssShmem')) : null,
    pss_mb: pssKb != null ? kbToMb(pssKb) : null
  };
}

function median(nums) {
  const s = nums.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  if (s.length === 0) return null;
  if (s.length % 2 === 0) return Math.round(((s[mid - 1] + s[mid]) / 2) * 10) / 10;
  return s[mid];
}

function parseArgs() {
  const runtimes = [];
  const bunCanary = path.join(os.homedir(), '.bun/bin/bun');
  const bun140 = path.join(ROOT, 'tmp/bun-runtimes/1.4.0-baseline/bun');
  const only = process.env.ONLY || '';
  const defaultIds = new Set(['node', 'bun-1.4.0', 'bun-1.4.1-canary']);

  const all = [
    {
      id: 'node',
      label: 'Node v24',
      bin: process.execPath,
      args: ['--expose-gc', CHILD]
    },
    {
      id: 'bun-1.4.0',
      label: 'Bun 1.4.0',
      bin: bun140,
      args: [CHILD]
    },
    {
      id: 'bun-1.4.1-canary',
      label: 'Bun 1.4.1-canary (A0 interprété)',
      bin: bunCanary,
      args: [CHILD]
    },
    {
      id: 'a1-bundle',
      label: 'A1 bun build CJS',
      bin: bunCanary,
      args: [path.join(ROOT, 'tmp/bun-build/a1/load-and-hold.js')]
    },
    {
      id: 'a2-bytecode',
      label: 'A2 bun build --bytecode',
      bin: bunCanary,
      args: [path.join(ROOT, 'tmp/bun-build/a2/load-and-hold.js')]
    },
    {
      id: 'a3-compile',
      label: 'A3 bun build --compile',
      bin: path.join(ROOT, 'tmp/bun-build/a3/load-and-hold'),
      args: []
    },
    {
      id: 'a4-aot',
      label: 'A4 bun build --compile --aot',
      bin: path.join(ROOT, 'tmp/bun-build/a4/load-and-hold'),
      args: []
    },
    {
      id: 'a5-aot-trim',
      label: 'A5 bun build --compile --aot --trim',
      bin: path.join(ROOT, 'tmp/bun-build/a5/load-and-hold'),
      args: []
    },
    {
      id: 'b1-fms-overlay',
      label: 'B1 frozenminisearch bun-build overlay',
      bin: bunCanary,
      args: [CHILD]
    }
  ];

  for (const rt of all) {
    if (only) {
      if (!only.split(',').includes(rt.id)) continue;
    } else if (!defaultIds.has(rt.id)) {
      continue;
    }
    if (!fs.existsSync(rt.bin)) {
      console.error(`SKIP ${rt.id}: binaire introuvable (${rt.bin})`);
      continue;
    }
    const entry = rt.args.find((a) => typeof a === 'string' && a.endsWith('.js'));
    if (entry && !fs.existsSync(entry)) {
      console.error(`SKIP ${rt.id}: entrée introuvable (${entry})`);
      continue;
    }
    runtimes.push(rt);
  }
  return runtimes;
}

function runOne(rt, opts = {}) {
  return new Promise((resolve, reject) => {
    const settleMs = opts.settleMs != null ? opts.settleMs : SETTLE_MS;
    const env = {
      ...process.env,
      NODE_ENV: 'production',
      CORPUS_LIGHT_PROFILE: 'true',
      LOAD_HAS_AVIS: process.env.LOAD_HAS_AVIS || 'true',
      LOAD_MITM: process.env.LOAD_MITM || 'true',
      VET_GAP_MS: String(opts.vetGapMs != null ? opts.vetGapMs : VET_GAP_MS),
      SETTLE_MS: String(settleMs),
      POST_GC_HOLD_MS: String(opts.postGcHoldMs != null ? opts.postGcHoldMs : POST_GC_HOLD_MS),
      SEARCH_SMOKE: opts.searchSmoke != null ? String(opts.searchSmoke) : process.env.SEARCH_SMOKE || '1'
    };
    delete env.PORT;

    const child = spawn(rt.bin, rt.args, {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const events = [];
    const samples = [];
    let stderrBuf = '';
    let stdoutTail = '';
    let lastProc = null;
    let peakHwm = 0;
    let peakRss = 0;
    let peakPss = 0;
    let peakAnon = 0;
    const tStart = Date.now();
    let sampleEvery = SAMPLE_MS;
    let lastSampleAt = 0;

    const sampler = setInterval(() => {
      const now = Date.now();
      if (now - lastSampleAt < sampleEvery - 5) return;
      lastSampleAt = now;
      try {
        lastProc = readProc(child.pid);
        samples.push({ t_ms: now - tStart, ...lastProc });
        if (lastProc.hwm_mb > peakHwm) peakHwm = lastProc.hwm_mb;
        if (lastProc.rss_mb > peakRss) peakRss = lastProc.rss_mb;
        if (lastProc.pss_mb != null && lastProc.pss_mb > peakPss) peakPss = lastProc.pss_mb;
        if (lastProc.anon_mb != null && lastProc.anon_mb > peakAnon) peakAnon = lastProc.anon_mb;
      } catch {
        // process gone
      }
    }, Math.min(SAMPLE_MS, SETTLE_SAMPLE_MS));

    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString('utf8');
      const lines = stderrBuf.split('\n');
      stderrBuf = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('__MEM__')) continue;
        try {
          const ev = JSON.parse(line.slice('__MEM__'.length));
          events.push(ev);
          if (ev.event === 'search_done' || (ev.event === 'vet_done' && process.env.SEARCH_SMOKE === '0')) {
            sampleEvery = SETTLE_SAMPLE_MS;
          }
          const extra =
            ev.waited_ms != null ? ` +${Math.round(ev.waited_ms / 1000)}s` : '';
          process.stderr.write(
            `  [${rt.id}] ${ev.event}${extra} t=${ev.t_ms}ms rss=${ev.rss_mb}` +
              (ev.anon_mb != null ? ` anon=${ev.anon_mb}` : '') +
              ` heap=${ev.heap_used_mb}` +
              (ev.duration_ms != null ? ` dur=${ev.duration_ms}ms` : '') +
              '\n'
          );
        } catch {
          // ignore malformed protocol lines
        }
      }
    });

    child.stdout.on('data', (chunk) => {
      stdoutTail += chunk.toString('utf8');
      if (stdoutTail.length > 4000) stdoutTail = stdoutTail.slice(-2000);
    });

    child.on('error', (err) => {
      clearInterval(sampler);
      reject(err);
    });

    child.on('close', (code) => {
      clearInterval(sampler);
      try {
        lastProc = readProc(child.pid);
      } catch {
        // already reaped
      }
      const find = (name) => events.filter((e) => e.event === name);
      const last = (name) => {
        const xs = find(name);
        return xs[xs.length - 1] || null;
      };
      const settleAt = (waitedMs) =>
        events.find((e) => e.event === 'settle' && e.waited_ms === waitedMs) || null;
      const sampleNear = (childTms) => {
        if (childTms == null || samples.length === 0) return null;
        let best = samples[0];
        for (const s of samples) {
          if (Math.abs(s.t_ms - childTms) < Math.abs(best.t_ms - childTms)) best = s;
        }
        return best;
      };
      const bdpm = last('bdpm_done');
      const vet = last('vet_done');
      const search = last('search_done');
      const settles = find('settle');
      const postGc = last('post_gc');
      const done = last('done');
      const runtimeEv = last('runtime');
      const s30 = settleAt(30_000);
      const s2m = settleAt(120_000);
      const s5m = settleAt(300_000);
      const sLast = settles.length ? settles[settles.length - 1] : null;
      const proc30 = sampleNear(s30 && s30.t_ms);
      const proc2m = sampleNear(s2m && s2m.t_ms);
      const proc5m = sampleNear(s5m && s5m.t_ms);
      const procLast = sampleNear(sLast && sLast.t_ms);

      if (code !== 0) {
        reject(
          new Error(
            `${rt.id} exited ${code}: ${stdoutTail.slice(-500)}\n` +
              `last events: ${events.map((e) => e.event).join(',')}`
          )
        );
        return;
      }

      resolve({
        runtime_id: rt.id,
        runtime_label: rt.label,
        runtime: runtimeEv && runtimeEv.runtime,
        peak_rss_mb: peakRss,
        peak_hwm_mb: peakHwm,
        peak_pss_mb: peakPss || null,
        peak_anon_mb: peakAnon || null,
        bdpm_duration_ms: bdpm && bdpm.duration_ms,
        vet_duration_ms: vet && vet.duration_ms,
        rss_bdpm_done_mb: bdpm && bdpm.rss_mb,
        rss_vet_done_mb: vet && vet.rss_mb,
        rss_search_done_mb: search && search.rss_mb,
        rss_settle_30s_mb: s30 && s30.rss_mb,
        rss_settle_2min_mb: s2m && s2m.rss_mb,
        rss_settle_5min_mb: s5m && s5m.rss_mb,
        rss_settle_mb: sLast && sLast.rss_mb,
        rss_post_gc_mb: postGc && postGc.rss_mb,
        rss_done_mb: done && done.rss_mb,
        anon_settle_30s_mb: proc30 && proc30.anon_mb,
        anon_settle_2min_mb: proc2m && proc2m.anon_mb,
        anon_settle_5min_mb: proc5m && proc5m.anon_mb,
        anon_settle_mb: procLast && procLast.anon_mb,
        proc_rss_settle_5min_mb: proc5m && proc5m.rss_mb,
        proc_rss_settle_mb: procLast && procLast.rss_mb,
        heap_bdpm_done_mb: bdpm && bdpm.heap_used_mb,
        heap_vet_done_mb: vet && vet.heap_used_mb,
        heap_settle_mb: sLast && sLast.heap_used_mb,
        heap_post_gc_mb: postGc && postGc.heap_used_mb,
        search_hits: search && search.hits,
        total_ms: done && done.total_ms,
        gc: done && done.gc,
        events,
        samples
      });
    });
  });
}

function summarize(runs) {
  const pick = (key) => runs.map((r) => r[key]).filter((x) => typeof x === 'number');
  return {
    n: runs.length,
    peak_hwm_mb: { values: pick('peak_hwm_mb'), median: median(pick('peak_hwm_mb')) },
    peak_rss_mb: { values: pick('peak_rss_mb'), median: median(pick('peak_rss_mb')) },
    rss_vet_done_mb: { values: pick('rss_vet_done_mb'), median: median(pick('rss_vet_done_mb')) },
    rss_settle_30s_mb: {
      values: pick('rss_settle_30s_mb'),
      median: median(pick('rss_settle_30s_mb'))
    },
    rss_settle_2min_mb: {
      values: pick('rss_settle_2min_mb'),
      median: median(pick('rss_settle_2min_mb'))
    },
    rss_settle_5min_mb: {
      values: pick('rss_settle_5min_mb'),
      median: median(pick('rss_settle_5min_mb'))
    },
    rss_settle_mb: { values: pick('rss_settle_mb'), median: median(pick('rss_settle_mb')) },
    rss_post_gc_mb: { values: pick('rss_post_gc_mb'), median: median(pick('rss_post_gc_mb')) },
    rss_done_mb: { values: pick('rss_done_mb'), median: median(pick('rss_done_mb')) },
    bdpm_duration_ms: {
      values: pick('bdpm_duration_ms'),
      median: median(pick('bdpm_duration_ms'))
    },
    vet_duration_ms: { values: pick('vet_duration_ms'), median: median(pick('vet_duration_ms')) },
    heap_post_gc_mb: { values: pick('heap_post_gc_mb'), median: median(pick('heap_post_gc_mb')) }
  };
}

async function main() {
  const runtimes = parseArgs();
  if (runtimes.length === 0) {
    console.error('Aucun runtime disponible');
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });

  const report = {
    started_at: new Date().toISOString(),
    host: os.hostname(),
    cpus: os.cpus().length,
    totalmem_mb: Math.round(os.totalmem() / 1048576),
    env: {
      NODE_ENV: 'production',
      CORPUS_LIGHT_PROFILE: true,
      LOAD_HAS_AVIS: process.env.LOAD_HAS_AVIS || 'true',
      LOAD_MITM: process.env.LOAD_MITM || 'true',
      VET_GAP_MS,
      SETTLE_MS,
      POST_GC_HOLD_MS,
      RUNS,
      SAMPLE_MS,
      SETTLE_SAMPLE_MS
    },
    note:
      'VmRSS / VmHWM / RssAnon via /proc (empreinte OS). process.memoryUsage().rss ≈ ce que PM2 affiche ; RssAnon est la part privée (sans .so partagés). heapUsed non comparable V8/JSC. Idle naturel 7 min (marqueurs serveur +30s/+2min/+5min) puis GC.',
    runs: [],
    by_runtime: {}
  };

  if (WARMUP) {
    const nodeRt = runtimes.find((r) => r.id === 'node') || runtimes[0];
    console.log(`\n=== warmup (${nodeRt.id}, discarded) ===`);
    try {
      await runOne(nodeRt, { settleMs: 0, vetGapMs: 0, searchSmoke: '0', postGcHoldMs: 0 });
    } catch (err) {
      console.warn('warmup failed (continue):', err.message);
    }
  }

  const queue = [];
  for (let i = 0; i < RUNS; i += 1) {
    for (const rt of runtimes) queue.push({ rt, runIndex: i + 1 });
  }

  for (const { rt, runIndex } of queue) {
    console.log(`\n=== ${rt.id} run ${runIndex}/${RUNS} ===`);
    const result = await runOne(rt);
    result.run_index = runIndex;
    const slim = { ...result, samples: undefined, events: undefined };
    report.runs.push({
      ...slim,
      sample_count: result.samples.length,
      event_names: result.events.map((e) => e.event)
    });
    if (!report.by_runtime[rt.id]) report.by_runtime[rt.id] = { runs: [] };
    report.by_runtime[rt.id].runs.push(slim);
    // timeline of last run kept for canvas
    report.by_runtime[rt.id].last_samples = result.samples.filter((_, i, arr) => {
      if (i === 0 || i === arr.length - 1) return true;
      const t = result.samples[i].t_ms;
      if (t < 30_000) return i % 5 === 0;
      return i % 2 === 0;
    });
    report.by_runtime[rt.id].last_events = result.events;
  }

  for (const rt of runtimes) {
    report.by_runtime[rt.id].summary = summarize(report.by_runtime[rt.id].runs);
  }

  report.finished_at = new Date().toISOString();
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`\nÉcrit: ${OUT}`);

  console.log('\n=== Médianes (Mo) ===');
  console.log(
    'runtime                  peak_hwm  rss_vet   +30s    +2min    +5min    +7min   post_gc'
  );
  for (const rt of runtimes) {
    const s = report.by_runtime[rt.id].summary;
    const row = [
      rt.id.padEnd(24),
      String(s.peak_hwm_mb.median).padStart(8),
      String(s.rss_vet_done_mb.median).padStart(8),
      String(s.rss_settle_30s_mb.median).padStart(7),
      String(s.rss_settle_2min_mb.median).padStart(7),
      String(s.rss_settle_5min_mb.median).padStart(7),
      String(s.rss_settle_mb.median).padStart(7),
      String(s.rss_post_gc_mb.median).padStart(8)
    ];
    console.log(row.join('  '));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
