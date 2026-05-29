'use strict';

/**
 * Échantillonnage mémoire haute fréquence (sans GC entre mesures → pic RSS réaliste).
 *
 * @param {object} opts
 * @param {number} [opts.intervalMs=200] — 5 échantillons/s par défaut
 * @param {boolean} [opts.gcBeforeSample=false] — true fausse les pics (réservé baseline)
 */
function createMemorySampler(opts = {}) {
  const intervalMs = Math.max(50, parseInt(opts.intervalMs || '200', 10));
  const gcBeforeSample = opts.gcBeforeSample === true;
  const samples = [];
  const marks = [];
  let timer = null;
  let t0 = 0;

  function mb(bytes) {
    return Math.round((bytes / 1024 / 1024) * 1000) / 1000;
  }

  function sampleMemory() {
    if (gcBeforeSample && typeof global.gc === 'function') {
      global.gc();
    }
    const u = process.memoryUsage();
    return {
      t_ms: Date.now() - t0,
      heapUsed_mb: mb(u.heapUsed),
      rss_mb: mb(u.rss),
      heapTotal_mb: mb(u.heapTotal),
      external_mb: mb(u.external)
    };
  }

  function start() {
    if (timer) return;
    t0 = Date.now();
    samples.length = 0;
    marks.length = 0;
    samples.push({ ...sampleMemory(), kind: 'sample' });
    timer = setInterval(() => {
      samples.push({ ...sampleMemory(), kind: 'sample' });
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
    samples.push({ ...sampleMemory(), kind: 'sample' });
  }

  /** Marqueur instantané (phase métier) — pas de GC. */
  function mark(phase, extra = {}) {
    const row = { ...sampleMemory(), kind: 'mark', phase, ...extra };
    marks.push(row);
    samples.push(row);
    return row;
  }

  function summarize() {
    const onlySamples = samples.filter((s) => s.kind === 'sample' || s.kind === 'mark');
    let peakRss = { rss_mb: 0, t_ms: 0, phase: null };
    let peakHeap = { heapUsed_mb: 0, t_ms: 0, phase: null };

    for (const s of onlySamples) {
      if (s.rss_mb > peakRss.rss_mb) {
        peakRss = { rss_mb: s.rss_mb, t_ms: s.t_ms, phase: s.phase || null };
      }
      if (s.heapUsed_mb > peakHeap.heapUsed_mb) {
        peakHeap = { heapUsed_mb: s.heapUsed_mb, t_ms: s.t_ms, phase: s.phase || null };
      }
    }

    const first = onlySamples[0];
    const last = onlySamples[onlySamples.length - 1];
    const durationMs = last ? last.t_ms - (first?.t_ms || 0) : 0;

    return {
      interval_ms: intervalMs,
      sample_count: onlySamples.filter((s) => s.kind === 'sample').length,
      mark_count: marks.length,
      duration_ms: durationMs,
      peak_rss: peakRss,
      peak_heap: peakHeap,
      first,
      last
    };
  }

  function samplesInWindow(tStartMs, tEndMs) {
    return samples.filter((s) => s.t_ms >= tStartMs && s.t_ms <= tEndMs);
  }

  function peakInWindow(tStartMs, tEndMs) {
    let peak = { rss_mb: 0, heapUsed_mb: 0, t_ms: 0 };
    for (const s of samplesInWindow(tStartMs, tEndMs)) {
      if (s.rss_mb > peak.rss_mb) peak = { ...peak, rss_mb: s.rss_mb, t_ms: s.t_ms };
      if (s.heapUsed_mb > peak.heapUsed_mb) {
        peak = { ...peak, heapUsed_mb: s.heapUsed_mb, t_ms: s.t_ms };
      }
    }
    return peak;
  }

  return {
    start,
    stop,
    mark,
    summarize,
    getSamples: () => samples.slice(),
    getMarks: () => marks.slice(),
    samplesInWindow,
    peakInWindow
  };
}

/** Enregistre global.__loadMemoryMark pour vetDataLoader / dataLoader. */
function installLoadMemoryMarks(sampler) {
  global.__loadMemoryMark = (phase, extra) => sampler.mark(phase, extra);
}

function uninstallLoadMemoryMarks() {
  delete global.__loadMemoryMark;
}

/** No-op sauf si installLoadMemoryMarks actif (scripts de profilage). */
function loadMemoryMark(phase, extra) {
  if (typeof global.__loadMemoryMark === 'function') {
    global.__loadMemoryMark(phase, extra);
  }
}

module.exports = {
  createMemorySampler,
  installLoadMemoryMarks,
  uninstallLoadMemoryMarks,
  loadMemoryMark
};
