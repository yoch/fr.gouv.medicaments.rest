export interface MemoryUsageMb {
  rss_mb: number;
  heap_used_mb: number;
  heap_total_mb: number;
  external_mb: number;
  array_buffers_mb: number;
  non_heap_mb: number;
}

function mb(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

function memoryUsageMb(): MemoryUsageMb {
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

function logMemoryUsage(label: string, extra: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify({
      event: 'memory_usage',
      label,
      ...memoryUsageMb(),
      ...extra
    })
  );
}

export { memoryUsageMb, logMemoryUsage };
