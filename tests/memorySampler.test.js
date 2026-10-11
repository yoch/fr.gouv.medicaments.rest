'use strict';

const { createMemorySampler, installLoadMemoryMarks, uninstallLoadMemoryMarks, loadMemoryMark } = require('../src/utils/memorySampler');

afterEach(() => { uninstallLoadMemoryMarks(); jest.restoreAllMocks(); jest.useRealTimers(); });

test('borne l’historique sans perdre le pic ou les compteurs globaux', () => {
  jest.useFakeTimers();
  const usage = { rss: 100 * 1048576, heapUsed: 20 * 1048576, heapTotal: 30 * 1048576, external: 1 * 1048576 };
  jest.spyOn(process, 'memoryUsage').mockImplementation(() => usage);
  const sampler = createMemorySampler({ intervalMs: 50, maxSamples: 3, maxMarks: 2 });
  sampler.start();
  usage.rss = 10 * 1048576;
  installLoadMemoryMarks(sampler);
  for (let n = 0; n < 5; n++) {
    loadMemoryMark(`phase-${n}`);
    jest.advanceTimersByTime(50);
  }
  sampler.stop();
  expect(sampler.getSamples()).toHaveLength(3);
  expect(sampler.getMarks().map(mark => mark.phase)).toEqual(['phase-3', 'phase-4']);
  expect(sampler.summarize()).toMatchObject({
    sample_count: 7, mark_count: 5, dropped_sample_count: 9,
    peak_rss: { rss_mb: 100 }, duration_ms: 250
  });
  expect(jest.getTimerCount()).toBe(0);
});

test('refuse une cadence invalide qui ferait tourner un timer à 1 ms', () => {
  expect(() => createMemorySampler({ intervalMs: 'invalid' })).toThrow(RangeError);
});
