// Global sliding-window rate limit for outbound Anthropic calls. Caps spend
// even when many authenticated users hit the agent endpoints in parallel.
//
// Lives in module scope, so the cap is per-process. Under serverless scale-out
// each instance has its own counter and the effective cap is roughly
// MAX_CALLS_PER_MINUTE * instances. Fine for a single-instance demo.

const MAX_CALLS_PER_MINUTE = 50;
const WINDOW_MS = 60_000;

const timestamps: number[] = [];

function makeAbortError(): Error {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(makeAbortError());
      return;
    }
    const timer = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        reject(makeAbortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

export async function acquireAnthropicSlot(signal?: AbortSignal): Promise<void> {
  while (true) {
    if (signal?.aborted) throw makeAbortError();
    const now = Date.now();
    while (timestamps.length > 0 && timestamps[0] <= now - WINDOW_MS) {
      timestamps.shift();
    }
    if (timestamps.length < MAX_CALLS_PER_MINUTE) {
      timestamps.push(now);
      return;
    }
    // Wait until the oldest call ages out of the window.
    const waitMs = Math.max(1, WINDOW_MS - (now - timestamps[0]) + 1);
    await sleep(waitMs, signal);
  }
}
