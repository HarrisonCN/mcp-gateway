/**
 * Counting semaphore used to enforce per-server `maxConcurrency`.
 *
 * @module utils/semaphore
 */

export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly max: number) {
    if (!Number.isFinite(max) || max < 1) this.max = Infinity;
  }

  /** Resolves with a release function once a slot is free. */
  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const grant = () => {
        this.active++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.active--;
          this.waiters.shift()?.();
        });
      };
      if (this.active < this.max) grant();
      else this.waiters.push(grant);
    });
  }

  get pending(): number {
    return this.waiters.length;
  }

  get inFlight(): number {
    return this.active;
  }
}
