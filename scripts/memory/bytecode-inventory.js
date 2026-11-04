#!/usr/bin/env node
/**
 * Inventaire bytecode JSC (tailles, pragma, mmap, portabilité, cold start).
 * Écrit tmp/bun-build/bytecode-inventory.json — ne committe pas les .jsc.
 */
'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const OUT_DIR = path.join(ROOT, 'tmp/bun-build');
const OUT = path.join(OUT_DIR, 'bytecode-inventory.json');
const BUN_CANARY = path.join(os.homedir(), '.bun/bin/bun');
const BUN_140 = path.join(ROOT, 'tmp/bun-runtimes/1.4.0-baseline/bun');

function kbToMb(kb) {
  return Math.round((kb / 1024) * 10) / 10;
}

function bytesToKb(n) {
  return Math.round((n / 1024) * 10) / 10;
}

function fileInfo(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const st = fs.statSync(filePath);
  return {
    path: path.relative(ROOT, filePath),
    bytes: st.size,
    kb: bytesToKb(st.size),
    mb: Math.round((st.size / 1048576) * 100) / 100
  };
}

function readHead(filePath, n = 3) {
  if (!fs.existsSync(filePath)) return null;
  const text = fs.readFileSync(filePath, 'utf8');
  return text.split('\n').slice(0, n);
}

function countAsync(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const text = fs.readFileSync(filePath, 'utf8');
  const asyncFn = (text.match(/\basync\s+function\b/g) || []).length;
  const asyncArrow = (text.match(/\basync\s*\(/g) || []).length;
  const generators = (text.match(/function\s*\*/g) || []).length;
  const evalCalls = (text.match(/\beval\s*\(/g) || []).length;
  return {
    bytes: Buffer.byteLength(text),
    async_function: asyncFn,
    async_paren: asyncArrow,
    generators,
    eval_calls: evalCalls
  };
}

function readProc(pid) {
  const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
  const pick = (key) => {
    const m = status.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'));
    return m ? parseInt(m[1], 10) : null;
  };
  return {
    rss_mb: kbToMb(pick('VmRSS') || 0),
    hwm_mb: kbToMb(pick('VmHWM') || 0),
    anon_mb: pick('RssAnon') != null ? kbToMb(pick('RssAnon')) : null,
    file_mb: pick('RssFile') != null ? kbToMb(pick('RssFile')) : null
  };
}

function parseMaps(pid, needle) {
  const maps = fs.readFileSync(`/proc/${pid}/maps`, 'utf8');
  const lines = maps.split('\n').filter((l) => l.includes(needle));
  return lines.map((line) => {
    const [range, perms, offset, , , ...rest] = line.trim().split(/\s+/);
    const [start, end] = (range || '').split('-');
    const size =
      start && end ? parseInt(end, 16) - parseInt(start, 16) : null;
    return {
      line,
      perms,
      offset,
      size_bytes: size,
      size_kb: size != null ? bytesToKb(size) : null,
      path: rest.join(' ')
    };
  });
}

function bunVersion(bin) {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
  return (r.stdout || '').trim();
}

function bunBuild(bin, args, cwd = ROOT) {
  const r = spawnSync(bin, ['build', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env }
  });
  return {
    status: r.status,
    stdout: (r.stdout || '').slice(-2000),
    stderr: (r.stderr || '').slice(-4000)
  };
}

function collectEvents(stderr) {
  const events = [];
  for (const line of stderr.split('\n')) {
    if (!line.startsWith('__MEM__')) continue;
    try {
      events.push(JSON.parse(line.slice('__MEM__'.length)));
    } catch {
      // ignore
    }
  }
  return events;
}

function runLoad(bin, args, extraEnv = {}, settleMs = 0) {
  const r = spawnSync(bin, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      CORPUS_LIGHT_PROFILE: 'true',
      LOAD_HAS_AVIS: 'true',
      LOAD_MITM: 'true',
      VET_GAP_MS: '0',
      SETTLE_MS: String(settleMs),
      POST_GC_HOLD_MS: '0',
      SEARCH_SMOKE: settleMs === 0 ? '1' : '1',
      ...extraEnv
    },
    timeout: 180_000,
    maxBuffer: 20 * 1024 * 1024
  });
  const events = collectEvents(r.stderr || '');
  const find = (name) => events.find((e) => e.event === name);
  return {
    status: r.status,
    error: r.error && r.error.message,
    timed_out: r.error && r.error.code === 'ETIMEDOUT',
    bdpm_start_ms: find('bdpm_start') && find('bdpm_start').t_ms,
    bdpm_duration_ms: find('bdpm_done') && find('bdpm_done').duration_ms,
    vet_duration_ms: find('vet_done') && find('vet_done').duration_ms,
    hits: find('search_done') && find('search_done').hits,
    runtime: find('runtime') && find('runtime').runtime,
    stderr_tail: (r.stderr || '').slice(-2500),
    stdout_tail: (r.stdout || '').slice(-1500),
    verbose_lines: (r.stderr || '')
      .split('\n')
      .filter((l) => /bytecode|disk.?cache|jsc|\.jsc|hash/i.test(l) && !l.startsWith('__MEM__'))
      .slice(0, 40)
  };
}

function spawnHold(bin, scriptPath, extraEnv = {}, holdMs = 4000) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [scriptPath], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        HOLD_MS: String(holdMs),
        ...extraEnv
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString('utf8');
    });
    const timer = setTimeout(() => {
      let proc = null;
      let maps = [];
      try {
        proc = readProc(child.pid);
        maps = parseMaps(child.pid, '.jsc');
      } catch (err) {
        proc = { error: err.message };
      }
      child.kill('SIGTERM');
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // gone
        }
      }, 500);
      resolve({
        pid: child.pid,
        proc,
        maps_jsc: maps,
        stdout: stdout.slice(-2000),
        stderr: stderr.slice(-2000)
      });
    }, holdMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', () => {
      // if it exits before hold, still try to parse stdout
    });
  });
}

function spawnRequireHold(bin, targetJs, extraEnv = {}, holdMs = 4000) {
  const probe = path.join(OUT_DIR, 'probe-require.js');
  return spawnHold(bin, probe, { ...extraEnv, PROBE_TARGET: path.resolve(ROOT, targetJs) }, holdMs);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const probeSrc = `'use strict';
const fs = require('fs');
const path = require('path');
function kbToMb(kb) { return Math.round((kb / 1024) * 10) / 10; }
function readProc() {
  const status = fs.readFileSync('/proc/' + process.pid + '/status', 'utf8');
  const pick = (key) => {
    const m = status.match(new RegExp('^' + key + ':\\\\s+(\\\\d+)', 'm'));
    return m ? parseInt(m[1], 10) : null;
  };
  return {
    rss_mb: kbToMb(pick('VmRSS') || 0),
    hwm_mb: kbToMb(pick('VmHWM') || 0),
    anon_mb: pick('RssAnon') != null ? kbToMb(pick('RssAnon')) : null,
    file_mb: pick('RssFile') != null ? kbToMb(pick('RssFile')) : null
  };
}
const target = process.env.PROBE_TARGET;
const holdMs = parseInt(process.env.HOLD_MS || '4000', 10);
const before = readProc();
require(path.resolve(target));
const after = readProc();
const maps = fs.readFileSync('/proc/' + process.pid + '/maps', 'utf8')
  .split('\\n')
  .filter((l) => l.includes('.jsc') || l.includes('load-and-hold') || l.includes('import-graph'));
process.stdout.write(JSON.stringify({ pid: process.pid, before, after, maps }) + '\\n');
setTimeout(() => process.exit(0), holdMs);
`;
  fs.writeFileSync(path.join(OUT_DIR, 'probe-require.js'), probeSrc);

  const importGraph = path.join(ROOT, 'scripts/memory/import-graph.js');
  const builds = {
    'a1-mod': bunBuild(BUN_CANARY, [
      importGraph,
      '--target=bun',
      '--format=cjs',
      '--external=7zip-bin',
      `--outfile=${path.join(OUT_DIR, 'a1-mod/import-graph.js')}`
    ]),
    'a2-mod': bunBuild(BUN_CANARY, [
      importGraph,
      '--target=bun',
      '--format=cjs',
      '--bytecode',
      '--external=7zip-bin',
      `--outdir=${path.join(OUT_DIR, 'a2-mod')}`,
      '--entry-naming=import-graph.[ext]'
    ]),
    'a2-mod-140': bunBuild(BUN_140, [
      importGraph,
      '--target=bun',
      '--format=cjs',
      '--bytecode',
      '--external=7zip-bin',
      `--outdir=${path.join(OUT_DIR, 'a2-mod-140')}`,
      '--entry-naming=import-graph.[ext]'
    ])
  };

  const artifacts = {
    a1: fileInfo(path.join(OUT_DIR, 'a1/load-and-hold.js')),
    a1_minify: fileInfo(path.join(OUT_DIR, 'a1-minify/load-and-hold.js')),
    a2_js: fileInfo(path.join(OUT_DIR, 'a2/load-and-hold.js')),
    a2_jsc: fileInfo(path.join(OUT_DIR, 'a2/load-and-hold.js.jsc')),
    a2_minify_js: fileInfo(path.join(OUT_DIR, 'a2-minify/load-and-hold.js')),
    a2_minify_jsc: fileInfo(path.join(OUT_DIR, 'a2-minify/load-and-hold.js.jsc')),
    a2_140_js: fileInfo(path.join(OUT_DIR, 'a2-140/load-and-hold.js')),
    a2_140_jsc: fileInfo(path.join(OUT_DIR, 'a2-140/load-and-hold.js.jsc')),
    a3: fileInfo(path.join(OUT_DIR, 'a3/load-and-hold')),
    a3_bytecode: fileInfo(path.join(OUT_DIR, 'a3-bytecode/load-and-hold')),
    bun_canary: fileInfo(BUN_CANARY),
    bun_140: fileInfo(BUN_140),
    a1_mod: fileInfo(path.join(OUT_DIR, 'a1-mod/import-graph.js')),
    a2_mod_js: fileInfo(path.join(OUT_DIR, 'a2-mod/import-graph.js')),
    a2_mod_jsc: fileInfo(path.join(OUT_DIR, 'a2-mod/import-graph.js.jsc')),
    a2_mod_140_js: fileInfo(path.join(OUT_DIR, 'a2-mod-140/import-graph.js')),
    a2_mod_140_jsc: fileInfo(path.join(OUT_DIR, 'a2-mod-140/import-graph.js.jsc'))
  };

  const ratio = (jsc, js) =>
    jsc && js && js.bytes ? Math.round((jsc.bytes / js.bytes) * 100) / 100 : null;

  const pragma = {
    a2: readHead(path.join(OUT_DIR, 'a2/load-and-hold.js'), 2),
    a2_minify: readHead(path.join(OUT_DIR, 'a2-minify/load-and-hold.js'), 2),
    a2_140: readHead(path.join(OUT_DIR, 'a2-140/load-and-hold.js'), 2),
    a2_mod: readHead(path.join(OUT_DIR, 'a2-mod/import-graph.js'), 2)
  };

  const coverage = {
    a1: countAsync(path.join(OUT_DIR, 'a1/load-and-hold.js')),
    a1_minify: countAsync(path.join(OUT_DIR, 'a1-minify/load-and-hold.js')),
    a2: countAsync(path.join(OUT_DIR, 'a2/load-and-hold.js')),
    a2_minify: countAsync(path.join(OUT_DIR, 'a2-minify/load-and-hold.js'))
  };

  console.log('--- require-only RssAnon / mmap ---');
  const requireOnly = {
    canary_a1_mod: await spawnRequireHold(BUN_CANARY, 'tmp/bun-build/a1-mod/import-graph.js'),
    canary_a2_mod: await spawnRequireHold(BUN_CANARY, 'tmp/bun-build/a2-mod/import-graph.js'),
    bun140_a1_mod: await spawnRequireHold(BUN_140, 'tmp/bun-build/a1-mod/import-graph.js'),
    bun140_a2_mod_canary_jsc: await spawnRequireHold(
      BUN_140,
      'tmp/bun-build/a2-mod/import-graph.js'
    ),
    bun140_a2_mod_140_jsc: await spawnRequireHold(
      BUN_140,
      'tmp/bun-build/a2-mod-140/import-graph.js'
    ),
    canary_a2_mod_140_jsc: await spawnRequireHold(
      BUN_CANARY,
      'tmp/bun-build/a2-mod-140/import-graph.js'
    )
  };

  for (const [k, v] of Object.entries(requireOnly)) {
    let parsed = null;
    try {
      parsed = JSON.parse((v.stdout || '').trim().split('\n')[0]);
    } catch {
      // ignore
    }
    requireOnly[k] = {
      pid: v.pid,
      proc_hold: v.proc,
      maps_jsc: v.maps_jsc,
      maps_count: (v.maps_jsc || []).length,
      stdout_probe: parsed,
      stderr_tail: (v.stderr || '').slice(-500)
    };
    console.log(
      `  ${k}: anon=${v.proc && v.proc.anon_mb} rss=${v.proc && v.proc.rss_mb} jsc_maps=${(v.maps_jsc || []).length}`
    );
  }

  console.log('--- verbose disk cache (canary A2, SETTLE=0) ---');
  const verboseAttempts = [];
  const verboseEnvs = [
    { BUN_JSC_verboseDiskCache: '1' },
    { JSC_verboseDiskCache: '1' },
    { BUN_DEBUG: 'jsc' }
  ];
  for (const extra of verboseEnvs) {
    const r = runLoad(BUN_CANARY, [path.join(OUT_DIR, 'a2/load-and-hold.js')], extra, 0);
    verboseAttempts.push({
      env: extra,
      status: r.status,
      hits: r.hits,
      verbose_lines: r.verbose_lines,
      bdpm_start_ms: r.bdpm_start_ms
    });
    console.log(`  env ${JSON.stringify(extra)} status=${r.status} hits=${r.hits} lines=${r.verbose_lines.length}`);
  }

  const jscOpts = spawnSync(
    BUN_CANARY,
    ['--jsc-options=verboseDiskCache=true', path.join(OUT_DIR, 'a2/load-and-hold.js')],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'production',
        CORPUS_LIGHT_PROFILE: 'true',
        LOAD_HAS_AVIS: 'true',
        LOAD_MITM: 'true',
        VET_GAP_MS: '0',
        SETTLE_MS: '0',
        POST_GC_HOLD_MS: '0',
        SEARCH_SMOKE: '1'
      },
      timeout: 180_000,
      maxBuffer: 20 * 1024 * 1024
    }
  );
  verboseAttempts.push({
    env: { argv: '--jsc-options=verboseDiskCache=true' },
    status: jscOpts.status,
    hits: (collectEvents(jscOpts.stderr || '').find((e) => e.event === 'search_done') || {}).hits,
    verbose_lines: (jscOpts.stderr || '')
      .split('\n')
      .filter((l) => /bytecode|disk.?cache|jsc|\.jsc|hash/i.test(l) && !l.startsWith('__MEM__'))
      .slice(0, 40)
  });

  console.log('--- portabilité ---');
  const portability = {
    canary_jsc_on_140: runLoad(BUN_140, [path.join(OUT_DIR, 'a2/load-and-hold.js')], {}, 0),
    jsc_140_on_canary: runLoad(BUN_CANARY, [path.join(OUT_DIR, 'a2-140/load-and-hold.js')], {}, 0),
    canary_jsc_on_canary: runLoad(BUN_CANARY, [path.join(OUT_DIR, 'a2/load-and-hold.js')], {}, 0)
  };
  for (const [k, v] of Object.entries(portability)) {
    console.log(`  ${k}: status=${v.status} hits=${v.hits} bdpm_start=${v.bdpm_start_ms}ms`);
    portability[k] = {
      status: v.status,
      hits: v.hits,
      bdpm_start_ms: v.bdpm_start_ms,
      bdpm_duration_ms: v.bdpm_duration_ms,
      runtime: v.runtime,
      error: v.error,
      stderr_interesting: v.verbose_lines
    };
  }

  console.log('--- cold start bdpm_start ×3 ---');
  const coldVariants = [
    { id: 'a0', bin: BUN_CANARY, args: [path.join(ROOT, 'scripts/memory/load-and-hold.js')] },
    { id: 'a1', bin: BUN_CANARY, args: [path.join(OUT_DIR, 'a1/load-and-hold.js')] },
    { id: 'a2', bin: BUN_CANARY, args: [path.join(OUT_DIR, 'a2/load-and-hold.js')] },
    { id: 'a2-minify', bin: BUN_CANARY, args: [path.join(OUT_DIR, 'a2-minify/load-and-hold.js')] },
    { id: 'a3', bin: path.join(OUT_DIR, 'a3/load-and-hold'), args: [] },
    { id: 'a3-bytecode', bin: path.join(OUT_DIR, 'a3-bytecode/load-and-hold'), args: [] }
  ];
  const coldStart = {};
  for (const v of coldVariants) {
    const runs = [];
    for (let i = 0; i < 3; i += 1) {
      const r = runLoad(v.bin, v.args, {}, 0);
      runs.push({
        status: r.status,
        bdpm_start_ms: r.bdpm_start_ms,
        bdpm_duration_ms: r.bdpm_duration_ms,
        hits: r.hits
      });
      console.log(`  ${v.id} #${i + 1} start=${r.bdpm_start_ms}ms load=${r.bdpm_duration_ms}ms hits=${r.hits}`);
    }
    const starts = runs.map((x) => x.bdpm_start_ms).filter((n) => typeof n === 'number');
    starts.sort((a, b) => a - b);
    coldStart[v.id] = {
      runs,
      median_bdpm_start_ms: starts.length ? starts[Math.floor(starts.length / 2)] : null
    };
  }

  let nodeModulesMb = null;
  try {
    const du = spawnSync('du', ['-sm', path.join(ROOT, 'node_modules')], { encoding: 'utf8' });
    nodeModulesMb = parseInt((du.stdout || '').trim().split(/\s+/)[0], 10) || null;
  } catch {
    // ignore
  }

  const report = {
    started_at: new Date().toISOString(),
    host: os.hostname(),
    bun_canary: bunVersion(BUN_CANARY),
    bun_140: bunVersion(BUN_140),
    note:
      'Bytecode JSC : tailles, pragma, proxy async (fallback source), mmap /proc, portabilité 1.4.0 ↔ canary, cold start jusqu’à bdpm_start.',
    builds_mod: Object.fromEntries(
      Object.entries(builds).map(([k, v]) => [k, { status: v.status, stderr: (v.stderr || '').slice(-500) }])
    ),
    artifacts,
    ratios: {
      a2_jsc_over_js: ratio(artifacts.a2_jsc, artifacts.a2_js),
      a2_minify_jsc_over_js: ratio(artifacts.a2_minify_jsc, artifacts.a2_minify_js),
      a2_140_jsc_over_js: ratio(artifacts.a2_140_jsc, artifacts.a2_140_js),
      a2_mod_jsc_over_js: ratio(artifacts.a2_mod_jsc, artifacts.a2_mod_js),
      a3_over_bun_canary: ratio(artifacts.a3, artifacts.bun_canary),
      a3_bytecode_over_a3: ratio(artifacts.a3_bytecode, artifacts.a3)
    },
    node_modules_mb: nodeModulesMb,
    pragma,
    coverage_proxy: coverage,
    require_only: requireOnly,
    verbose_disk_cache: verboseAttempts,
    portability,
    cold_start: coldStart,
    finished_at: new Date().toISOString()
  };

  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`\nÉcrit: ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
