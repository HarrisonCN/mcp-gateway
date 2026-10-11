/** 14.0.0 placeholder (tests-first): per-instance module state is not implemented yet. */
export class InstanceScope { constructor(readonly id: string) {} drop(_moduleId: string): void {} }
export function runInScope<T>(_s: InstanceScope, fn: () => T): T { return fn(); }
export function instanceLocal<T extends object>(_m: string, _n: string, factory: () => T): T { return factory(); }
