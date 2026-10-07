/**
 * Async Mutex
 *
 * Bug fix (v0.1.0): the server registry could attempt to restart the same
 * MCP server process multiple times concurrently when several requests
 * arrived simultaneously during a restart window, causing duplicate processes.
 * This lightweight mutex serialises critical sections without external deps.
 *
 * @module utils/mutex
 */

export class Mutex {
  private _queue: Array<() => void> = [];
  private _locked = false;

  /**
   * Acquire the lock. The returned release function is idempotent: calling it
   * more than once is a no-op (previously a double release could unlock the
   * mutex while another holder was still inside the critical section).
   */
  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const grant = () => {
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this._release();
        });
      };
      if (!this._locked) {
        this._locked = true;
        grant();
      } else {
        this._queue.push(grant);
      }
    });
  }

  /** Hand the lock directly to the next waiter, or unlock if none. */
  private _release(): void {
    const next = this._queue.shift();
    if (next) {
      next(); // lock stays held, ownership transfers
    } else {
      this._locked = false;
    }
  }

  get isLocked(): boolean {
    return this._locked;
  }

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
