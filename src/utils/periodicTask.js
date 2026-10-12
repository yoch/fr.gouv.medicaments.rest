'use strict';

const MAX_TIMER_MS = 2147483647;

function validateTimerDelay(ms, name, allowZero = false) {
  if (!Number.isSafeInteger(ms) || ms < (allowZero ? 0 : 1) || ms > MAX_TIMER_MS) {
    throw new RangeError(`${name} doit être compris entre ${allowZero ? 0 : 1} et ${MAX_TIMER_MS} ms`);
  }
  return ms;
}

/** Le délai suivant commence après la fin du travail ; run partage un cycle actif. */
function startPeriodicTask(task, delayMs, onError = console.error) {
  validateTimerDelay(delayMs, 'Intervalle de rafraîchissement');
  let timer = null;
  let pending = null;
  let stopped = false;

  function schedule() {
    if (stopped) return;
    timer = setTimeout(() => run().catch(onError), delayMs);
    timer.unref?.();
  }

  function run() {
    if (stopped) return Promise.resolve();
    if (pending) return pending;
    clearTimeout(timer);
    timer = null;
    pending = Promise.resolve().then(() => stopped ? undefined : task()).finally(() => {
      pending = null;
      schedule();
    });
    return pending;
  }

  function stop() {
    stopped = true;
    clearTimeout(timer);
    timer = null;
    return pending || Promise.resolve();
  }

  schedule();
  return { run, stop };
}

module.exports = { MAX_TIMER_MS, validateTimerDelay, startPeriodicTask };
