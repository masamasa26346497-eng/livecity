import { createRequestGuard } from './rate-guard.mjs';

// Offline city matching only; browser/pilot limits remain unchanged.
export function createPacedCityGuard({
  requestsPerMinute = 60, now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!Number.isFinite(requestsPerMinute) || requestsPerMinute < 1 || requestsPerMinute > 100) {
    throw new Error('requestsPerMinute must be between 1 and 100');
  }
  const interval = Math.ceil(60000 / requestsPerMinute) + 25;
  const guard = createRequestGuard({ maxRequestsPerWindow: requestsPerMinute,
    windowMs: 60000, maxRequestsPerSession: 200, now });
  let nextAt = 0;
  let tail = Promise.resolve();
  return {
    schedule(key, fn) {
      const task = tail.then(async () => {
        const wait = Math.max(0, nextAt - now());
        if (wait) await sleep(wait);
        nextAt = now() + interval;
        return guard.schedule(key, fn);
      });
      tail = task.catch(() => {});
      return task;
    },
    getStats: guard.getStats,
  };
}
