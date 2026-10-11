// 14.4.0 placeholder (test-first): replaced by the implementation.
export class SimulatedCrash extends Error {}
export const durableFaults: { afterCall?: (p: { runId: string; node: string; kind: string }) => void; afterCommit?: (p: { runId: string; node: string; kind: string }) => void; heartbeat?: (p: { instance: string; runId: string }) => void } = {};
