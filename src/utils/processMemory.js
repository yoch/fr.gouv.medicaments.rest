'use strict';

function mb(bytes) {
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

function memoryUsageMb() {
  const u = process.memoryUsage();
  return {
    rss_mb: mb(u.rss),
    heap_used_mb: mb(u.heapUsed),
    heap_total_mb: mb(u.heapTotal),
    external_mb: mb(u.external),
    array_buffers_mb: mb(u.arrayBuffers ?? 0),
    non_heap_mb: mb(Math.max(0, u.rss - u.heapUsed))
  };
}

function logMemoryUsage(label, extra = {}) {
  console.log(
    JSON.stringify({
      event: 'memory_usage',
      label,
      ...memoryUsageMb(),
      ...extra
    })
  );
}

module.exports = {
  memoryUsageMb,
  logMemoryUsage
};
