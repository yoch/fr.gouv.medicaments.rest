/**
 * Mesure les pics RSS (échantillonnage /proc + phases worker).
 * Usage: node tests/memory_peak_harness.js [--scenario boot|refresh] [--runs 3]
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { readProcStatusKb, mb } = require('../src/utils/memoryProfile');

const SAMPLE_MS = Number(process.env.MEMORY_SAMPLE_MS || 30);
const ROOT = path.join(__dirname, '..');
const REPORT_PATH = path.join(ROOT, 'reports', 'memory_peak_report.json');

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { scenario: 'boot', runs: 3, skipVet: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--scenario' && args[i + 1]) out.scenario = args[++i];
    else if (args[i] === '--runs' && args[i + 1]) out.runs = Number(args[++i]);
    else if (args[i] === '--skip-vet') out.skipVet = true;
  }
  return out;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function runOnce(scenario, skipVet) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      MEMORY_SCENARIO: scenario,
      MEMORY_SKIP_VET: skipVet ? 'true' : 'false',
      GC_BETWEEN_LOAD_PHASES: process.env.GC_BETWEEN_LOAD_PHASES || 'true'
    };
    if (env.GC_BETWEEN_LOAD_PHASES === 'true') {
      env.NODE_OPTIONS = [env.NODE_OPTIONS, '--expose-gc'].filter(Boolean).join(' ');
    }

    const child = spawn(
      process.execPath,
      [path.join(__dirname, 'memory_worker.js')],
      { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] }
    );

    const samples = [];
    const phases = [];
    let stderr = '';

    const timer = setInterval(() => {
      const proc = readProcStatusKb(child.pid);
      if (proc.vm_rss_kb != null) {
        samples.push({
          t_ms: Date.now() - startMs,
          rss_mb: mb(proc.vm_rss_kb * 1024),
          hwm_mb: proc.vm_hwm_kb != null ? mb(proc.vm_hwm_kb * 1024) : null
        });
      }
    }, SAMPLE_MS);

    const startMs = Date.now();

    child.stdout.on('data', (buf) => {
      for (const line of buf.toString().split('\n')) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'phase') phases.push(msg);
        } catch {
          // ignore non-json
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('close', (code) => {
      clearInterval(timer);
      if (code !== 0) {
        reject(new Error(stderr || `worker exit ${code}`));
        return;
      }
      const rssSorted = samples.map((s) => s.rss_mb).sort((a, b) => a - b);
      const hwmFromPhases = phases
        .map((p) => p.memory?.proc_hwm_mb)
        .filter((v) => typeof v === 'number');
      const peakRssSampled = rssSorted.length ? Math.max(...rssSorted) : null;
      const peakHwmProc = hwmFromPhases.length ? Math.max(...hwmFromPhases) : null;
      const lastPhase = phases[phases.length - 1];

      resolve({
        duration_ms: Date.now() - startMs,
        sample_count: samples.length,
        peak_rss_sampled_mb: peakRssSampled,
        peak_rss_p95_mb: percentile(rssSorted, 95),
        peak_hwm_proc_mb: peakHwmProc,
        steady_rss_mb: lastPhase?.memory?.rss_mb ?? null,
        steady_heap_mb: lastPhase?.memory?.heap_used_mb ?? null,
        phases: phases.map((p) => ({
          phase: p.phase,
          rss_mb: p.memory?.rss_mb,
          heap_mb: p.memory?.heap_used_mb,
          hwm_mb: p.memory?.proc_hwm_mb
        }))
      });
    });
  });
}

async function main() {
  const { scenario, runs, skipVet } = parseArgs();
  const runResults = [];

  for (let i = 0; i < runs; i++) {
    console.log(`Run ${i + 1}/${runs} (${scenario})...`);
    runResults.push(await runOnce(scenario, skipVet));
  }

  const peaks = runResults.map((r) => r.peak_rss_sampled_mb).filter((v) => v != null);
  const hwms = runResults.map((r) => r.peak_hwm_proc_mb).filter((v) => v != null);
  const report = {
    generated_at: new Date().toISOString(),
    scenario,
    runs,
    skip_vet: skipVet,
    sample_interval_ms: SAMPLE_MS,
    node_version: process.version,
    aggregate: {
      peak_rss_sampled_mb_max: peaks.length ? Math.max(...peaks) : null,
      peak_rss_sampled_mb_p95: percentile([...peaks].sort((a, b) => a - b), 95),
      peak_hwm_proc_mb_max: hwms.length ? Math.max(...hwms) : null,
      steady_rss_mb_avg:
        runResults.reduce((s, r) => s + (r.steady_rss_mb || 0), 0) / runResults.length
    },
    acceptance: {
      peak_under_500_mb:
        (peaks.length ? Math.max(...peaks) : Infinity) < 500 &&
        (hwms.length ? Math.max(...hwms) : Infinity) < 500,
      steady_under_450_mb:
        runResults.every((r) => (r.steady_rss_mb ?? Infinity) <= 450)
    },
    runs: runResults
  };

  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`Rapport écrit: ${REPORT_PATH}`);
  console.log(JSON.stringify(report.aggregate, null, 2));
  console.log(`Critères: ${JSON.stringify(report.acceptance)}`);

  if (!report.acceptance.peak_under_500_mb) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
