import { validateTimerDelay } from './periodicTask.mts';

export interface MemorySamplerOptions {
  intervalMs?: number;
  gcBeforeSample?: boolean;
  maxSamples?: number;
  maxMarks?: number;
}

export interface MemorySample {
  t_ms: number;
  heapUsed_mb: number;
  rss_mb: number;
  heapTotal_mb: number;
  external_mb: number;
  kind: 'sample' | 'mark';
  phase?: string;
  [key: string]: unknown;
}

export interface PeakMetric {
  rss_mb?: number;
  heapUsed_mb?: number;
  t_ms: number;
  phase: string | null;
}

/**
 * Échantillonnage mémoire haute fréquence (sans GC entre mesures → pic RSS réaliste).
 */
function createMemorySampler(opts: MemorySamplerOptions = {}) {
  const intervalMs = Math.max(50, parseInt(String(opts.intervalMs || '200'), 10));
  validateTimerDelay(intervalMs, 'intervalMs du sampler');
  const gcBeforeSample = opts.gcBeforeSample === true;
  const maxSamples = opts.maxSamples ?? 10000;
  const maxMarks = opts.maxMarks ?? 1000;
  for (const value of [intervalMs, maxSamples, maxMarks]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('Paramètre du sampler invalide');
  }
  const samples: MemorySample[] = [];
  const marks: MemorySample[] = [];
  let timer: ReturnType<typeof setInterval> | null = null;
  let t0 = 0;
  let first: MemorySample | undefined;
  let last: MemorySample | undefined;
  let sampleCount = 0;
  let markCount = 0;
  let peakRss: { rss_mb: number; t_ms: number; phase: string | null } | undefined;
  let peakHeap: { heapUsed_mb: number; t_ms: number; phase: string | null } | undefined;

  function remember(row: MemorySample): void {
    first ??= row;
    last = row;
    if (!peakRss || row.rss_mb > peakRss.rss_mb) {
      peakRss = { rss_mb: row.rss_mb, t_ms: row.t_ms, phase: row.phase || null };
    }
    if (!peakHeap || row.heapUsed_mb > peakHeap.heapUsed_mb) {
      peakHeap = { heapUsed_mb: row.heapUsed_mb, t_ms: row.t_ms, phase: row.phase || null };
    }
    if (row.kind === 'sample') sampleCount++;
    if (samples.length === maxSamples) samples.shift();
    samples.push(row);
  }

  function mb(bytes: number): number {
    return Math.round((bytes / 1024 / 1024) * 1000) / 1000;
  }

  function sampleMemory(kind: 'sample' | 'mark' = 'sample', phase?: string): MemorySample {
    const globalWithGc = globalThis as typeof globalThis & { gc?: () => void };
    if (gcBeforeSample && typeof globalWithGc.gc === 'function') {
      globalWithGc.gc();
    }
    const u = process.memoryUsage();
    return phase !== undefined
      ? {
          t_ms: Date.now() - t0,
          heapUsed_mb: mb(u.heapUsed),
          rss_mb: mb(u.rss),
          heapTotal_mb: mb(u.heapTotal),
          external_mb: mb(u.external),
          kind,
          phase
        }
      : {
          t_ms: Date.now() - t0,
          heapUsed_mb: mb(u.heapUsed),
          rss_mb: mb(u.rss),
          heapTotal_mb: mb(u.heapTotal),
          external_mb: mb(u.external),
          kind
        };
  }

  function start(): void {
    if (timer) return;
    t0 = Date.now();
    samples.length = 0;
    marks.length = 0;
    first = last = peakRss = peakHeap = undefined;
    sampleCount = markCount = 0;
    remember(sampleMemory('sample'));
    timer = setInterval(() => {
      remember(sampleMemory('sample'));
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stop(): void {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
    remember(sampleMemory('sample'));
  }

  /** Marqueur instantané (phase métier) — pas de GC. */
  function mark(phase: string, extra: Record<string, unknown> = {}): MemorySample {
    const base = sampleMemory('mark', phase);
    const row: MemorySample = { ...base, ...extra, kind: 'mark', phase };
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

  function samplesInWindow(tStartMs: number, tEndMs: number): MemorySample[] {
    return samples.filter((s) => s.t_ms >= tStartMs && s.t_ms <= tEndMs);
  }

  function peakInWindow(tStartMs: number, tEndMs: number) {
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

type MemorySampler = ReturnType<typeof createMemorySampler>;

/** Enregistre global.__loadMemoryMark pour vetDataLoader / dataLoader. */
function installLoadMemoryMarks(sampler: MemorySampler): void {
  (globalThis as typeof globalThis & { __loadMemoryMark?: (phase: string, extra?: Record<string, unknown>) => void })
    .__loadMemoryMark = (phase, extra) => sampler.mark(phase, extra);
}

function uninstallLoadMemoryMarks(): void {
  delete (globalThis as typeof globalThis & { __loadMemoryMark?: unknown }).__loadMemoryMark;
}

/** No-op sauf si installLoadMemoryMarks actif (scripts de profilage). */
function loadMemoryMark(phase: string, extra?: Record<string, unknown>): void {
  const fn = (globalThis as typeof globalThis & { __loadMemoryMark?: (phase: string, extra?: Record<string, unknown>) => void })
    .__loadMemoryMark;
  if (typeof fn === 'function') {
    fn(phase, extra);
  }
}

export {
  createMemorySampler,
  installLoadMemoryMarks,
  uninstallLoadMemoryMarks,
  loadMemoryMark
};
