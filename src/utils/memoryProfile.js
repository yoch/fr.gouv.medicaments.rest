const fs = require('fs');

const PAGE_SIZE_KB = 4;

function mb(bytes) {
  return Math.round((bytes / 1024 / 1024) * 100) / 100;
}

function readProcStatusKb(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const pick = (key) => {
      const match = raw.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'));
      return match ? Number(match[1]) : null;
    };
    return {
      vm_rss_kb: pick('VmRSS'),
      vm_hwm_kb: pick('VmHWM'),
      vm_peak_kb: pick('VmPeak')
    };
  } catch {
    return { vm_rss_kb: null, vm_hwm_kb: null, vm_peak_kb: null };
  }
}

function snapshotProcessMemory(pid = process.pid) {
  const u = process.memoryUsage();
  const proc = pid === process.pid ? readProcStatusKb(pid) : readProcStatusKb(pid);
  let maxRssKb = null;
  try {
    const usage = process.resourceUsage();
    if (usage && usage.maxRSS) {
      maxRssKb = usage.maxRSS;
    }
  } catch {
    // Node < 16.14 may not expose resourceUsage
  }

  return {
    rss_mb: mb(u.rss),
    heap_used_mb: mb(u.heapUsed),
    heap_total_mb: mb(u.heapTotal),
    external_mb: mb(u.external),
    array_buffers_mb: mb(u.arrayBuffers ?? 0),
    non_heap_mb: mb(Math.max(0, u.rss - u.heapUsed)),
    proc_rss_mb: proc.vm_rss_kb != null ? mb(proc.vm_rss_kb * 1024) : null,
    proc_hwm_mb: proc.vm_hwm_kb != null ? mb(proc.vm_hwm_kb * 1024) : null,
    proc_peak_mb: proc.vm_peak_kb != null ? mb(proc.vm_peak_kb * 1024) : null,
    max_rss_mb: maxRssKb != null ? mb(maxRssKb * PAGE_SIZE_KB) : null
  };
}

let phaseMarkers = [];
let enabled = process.env.MEMORY_PROFILE === 'true';

function setMemoryProfiling(on) {
  enabled = Boolean(on);
}

function markMemoryPhase(phase, extra = {}) {
  const entry = {
    phase,
    at: new Date().toISOString(),
    memory: snapshotProcessMemory(),
    ...extra
  };
  phaseMarkers.push(entry);
  if (enabled) {
    console.log(
      `[memory] ${phase} rss=${entry.memory.rss_mb}Mo heap=${entry.memory.heap_used_mb}Mo hwm=${entry.memory.proc_hwm_mb ?? 'n/a'}Mo`
    );
  }
  return entry;
}

function getMemoryPhases() {
  return phaseMarkers;
}

function resetMemoryPhases() {
  phaseMarkers = [];
}

function maybeGc(label) {
  if (typeof global.gc !== 'function') return false;
  if (process.env.GC_BETWEEN_LOAD_PHASES !== 'true') return false;
  const before = snapshotProcessMemory();
  global.gc();
  const after = snapshotProcessMemory();
  if (enabled) {
    console.log(
      `[memory] gc(${label}) rss ${before.rss_mb} -> ${after.rss_mb} Mo`
    );
  }
  return true;
}

function summarizePhases() {
  if (phaseMarkers.length === 0) return null;
  const rssValues = phaseMarkers
    .map((m) => m.memory.rss_mb)
    .filter((v) => typeof v === 'number');
  const hwmValues = phaseMarkers
    .map((m) => m.memory.proc_hwm_mb)
    .filter((v) => typeof v === 'number');
  const maxRss = rssValues.length ? Math.max(...rssValues) : null;
  const maxHwm = hwmValues.length ? Math.max(...hwmValues) : null;
  return {
    phases: phaseMarkers.length,
    peak_rss_mb: maxRss,
    peak_hwm_mb: maxHwm,
    last: phaseMarkers[phaseMarkers.length - 1]
  };
}

module.exports = {
  mb,
  snapshotProcessMemory,
  readProcStatusKb,
  markMemoryPhase,
  getMemoryPhases,
  resetMemoryPhases,
  setMemoryProfiling,
  maybeGc,
  summarizePhases
};
