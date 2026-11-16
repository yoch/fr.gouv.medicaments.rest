const MAX_TIMER_MS = 2147483647;

function validateTimerDelay(ms: number, name: string, allowZero = false): number {
  if (!Number.isSafeInteger(ms) || ms < (allowZero ? 0 : 1) || ms > MAX_TIMER_MS) {
    throw new RangeError(`${name} doit être compris entre ${allowZero ? 0 : 1} et ${MAX_TIMER_MS} ms`);
  }
  return ms;
}

export interface PeriodicTaskHandle {
  run: () => Promise<void>;
  stop: () => Promise<void>;
}

/** Le délai suivant commence après la fin du travail ; run partage un cycle actif. */
function startPeriodicTask(
  task: () => Promise<void> | void,
  delayMs: number,
  onError: (err: unknown) => void = console.error
): PeriodicTaskHandle {
  validateTimerDelay(delayMs, 'Intervalle de rafraîchissement');
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: Promise<void> | null = null;
  let stopped = false;

  function schedule(): void {
    if (stopped) return;
    timer = setTimeout(() => run().catch(onError), delayMs);
    timer.unref?.();
  }

  function run(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (pending) return pending;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    pending = Promise.resolve()
      .then(() => (stopped ? undefined : task()))
      .finally(() => {
        pending = null;
        schedule();
      });
    return pending;
  }

  function stop(): Promise<void> {
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    return pending || Promise.resolve();
  }

  schedule();
  return { run, stop };
}

export { MAX_TIMER_MS, validateTimerDelay, startPeriodicTask };
