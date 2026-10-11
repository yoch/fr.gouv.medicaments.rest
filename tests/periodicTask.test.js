'use strict';

const { startPeriodicTask } = require('../src/utils/periodicTask');

describe('rafraîchissements séquentiels', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('attend la fin d’un cycle avant de programmer le prochain et partage les appels manuels', async () => {
    let release;
    const task = jest.fn(() => new Promise(resolve => { release = resolve; }));
    const periodic = startPeriodicTask(task, 100);
    await jest.advanceTimersByTimeAsync(100);
    expect(task).toHaveBeenCalledTimes(1);
    const first = periodic.run();
    expect(periodic.run()).toBe(first);
    await jest.advanceTimersByTimeAsync(1000);
    expect(task).toHaveBeenCalledTimes(1);
    release();
    await first;
    await jest.advanceTimersByTimeAsync(99);
    expect(task).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(task).toHaveBeenCalledTimes(2);
    const closing = periodic.stop();
    release();
    await closing;
    await jest.advanceTimersByTimeAsync(1000);
    await periodic.run();
    expect(task).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('récupère après un échec et ne conserve aucun timer après arrêt', async () => {
    const error = new Error('remote failed');
    const task = jest.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined);
    const onError = jest.fn();
    const periodic = startPeriodicTask(task, 100, onError);
    await jest.advanceTimersByTimeAsync(100);
    expect(onError).toHaveBeenCalledWith(error);
    await jest.advanceTimersByTimeAsync(100);
    expect(task).toHaveBeenCalledTimes(2);
    await periodic.stop();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('refuse les délais invalides avant de créer un timer', () => {
    for (const ms of [0, -1, 2147483648, Infinity, NaN]) {
      expect(() => startPeriodicTask(() => {}, ms)).toThrow(RangeError);
    }
    expect(jest.getTimerCount()).toBe(0);
  });
});
