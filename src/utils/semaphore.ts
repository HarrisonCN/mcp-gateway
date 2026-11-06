/**
 * Counting semaphore used to enforce per-server `maxConcurrency`.
 *
 * @module utils/semaphore
 */

type Release = () => void;
type WaitResult = Release | 'timeout' | 'aborted';

export class Semaphore {
  private active = 0;
  private readonly waiters = new Set<() => void>();

  constructor(private readonly max: number) {
    if (!Number.isFinite(max) || max < 1) this.max = Infinity;
  }

  /** Wait for a slot in FIFO order. A timed-out or aborted wait frees its queue entry immediately. */
  acquire(): Promise<Release>;
  acquire(timeoutMs: number, signal?: AbortSignal): Promise<WaitResult>;
  acquire(timeoutMs?: number, signal?: AbortSignal): Promise<WaitResult> {
    if (signal?.aborted) return Promise.resolve('aborted');
    if (this.active < this.max) return Promise.resolve(this.takeSlot());

    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const finish = (result: WaitResult) => {
        this.waiters.delete(grant);
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        resolve(result);
      };
      const grant = () => finish(this.takeSlot());
      const abort = () => finish('aborted');
      this.waiters.add(grant);
      signal?.addEventListener('abort', abort, { once: true });
      if (timeoutMs !== undefined) timer = setTimeout(() => finish('timeout'), timeoutMs);
    });
  }

  private takeSlot(): Release {
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.waiters.values().next().value?.();
    };
  }

  get pending(): number {
    return this.waiters.size;
  }

  get inFlight(): number {
    return this.active;
  }
}
