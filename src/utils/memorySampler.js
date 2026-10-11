'use strict';

/**
 * Échantillonnage mémoire haute fréquence (sans GC entre mesures → pic RSS réaliste).
 *
 * @param {object} opts
 * @param {number} [opts.intervalMs=200] — 5 échantillons/s par défaut
 * @param {boolean} [opts.gcBeforeSample=false] — true fausse les pics (réservé baseline)
 * @param {number} [opts.maxSamples=10000] — historique récent, pics globaux conservés
 * @param {number} [opts.maxMarks=1000] — marqueurs récents
 */
function createMemorySampler(opts = {}) {
  const intervalMs = Math.max(50, parseInt(opts.intervalMs || '200', 10));
  const gcBeforeSample = opts.gcBeforeSample === true;
  const maxSamples = opts.maxSamples ?? 10000;
  const maxMarks = opts.maxMarks ?? 1000;
  for (const value of [intervalMs, maxSamples, maxMarks]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('Paramètre du sampler invalide');
  }
  const samples = [];
  const marks = [];
  let timer = null;
  let t0 = 0;
  let first;
  let last;
  let sampleCount = 0;
  let markCount = 0;
  let peakRss;
  let peakHeap;

  function remember(row) {
    first ??= row;
    last = row;
    if (!peakRss || row.rss_mb > peakRss.rss_mb) peakRss = { rss_mb: row.rss_mb, t_ms: row.t_ms, phase: row.phase || null };
    if (!peakHeap || row.heapUsed_mb > peakHeap.heapUsed_mb) peakHeap = { heapUsed_mb: row.heapUsed_mb, t_ms: row.t_ms, phase: row.phase || null };
    if (row.kind === 'sample') sampleCount++;
    if (samples.length === maxSamples) samples.shift();
    samples.push(row);
  }

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
    first = last = peakRss = peakHeap = undefined;
    sampleCount = markCount = 0;
    remember({ ...sampleMemory(), kind: 'sample' });
    timer = setInterval(() => {
      remember({ ...sampleMemory(), kind: 'sample' });
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
    remember({ ...sampleMemory(), kind: 'sample' });
  }

  /** Marqueur instantané (phase métier) — pas de GC. */
  function mark(phase, extra = {}) {
    const row = { ...sampleMemory(), kind: 'mark', phase, ...extra };
    markCount++;
    if (marks.length === maxMarks) marks.shift();
    marks.push(row);
    remember(row);
    return row;
  }

  function summarize() {
    const durationMs = last ? last.t_ms - (first?.t_ms || 0) : 0;

    return {
      interval_ms: intervalMs,
      sample_count: sampleCount,
      mark_count: markCount,
      dropped_sample_count: Math.max(0, sampleCount + markCount - samples.length),
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
