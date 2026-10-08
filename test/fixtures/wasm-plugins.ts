/**
 * Tiny WebAssembly binary encoder for the WASM plugin tests (no toolchain needed). Builds modules that follow
 * the plugin ABI: `memory`, `alloc`, and `on_tool_call` / `on_response` returning `(ptr << 32) | len`.
 */
const uleb = (n: number): number[] => {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n !== 0) b |= 0x80;
    out.push(b);
  } while (n !== 0);
  return out;
};
const sleb = (v: bigint): number[] => {
  const out: number[] = [];
  for (;;) {
    const b = Number(v & 0x7fn);
    v >>= 7n;
    if ((v === 0n && (b & 0x40) === 0) || (v === -1n && (b & 0x40) !== 0)) {
      out.push(b);
      return out;
    }
    out.push(b | 0x80);
  }
};
const vec = (items: number[][]): number[] => [...uleb(items.length), ...items.flat()];
const str = (s: string): number[] => {
  const b = [...Buffer.from(s, 'utf8')];
  return [...uleb(b.length), ...b];
};
const section = (id: number, body: number[]): number[] => [id, ...uleb(body.length), ...body];

const I32 = 0x7f;
const I64 = 0x7e;
const op = {
  i32: (n: number) => [0x41, ...sleb(BigInt(n))],
  i64: (n: bigint) => [0x42, ...sleb(n)],
  get: (i: number) => [0x20, i],
  load8: [0x2d, 0x00, 0x00],
  store8: [0x3a, 0x00, 0x00],
  add: [0x6a],
  drop: [0x1a],
  grow: [0x40, 0x00],
  call: (i: number) => [0x10, ...uleb(i)],
  loopForever: [0x03, 0x40, 0x0c, 0x00, 0x0b],
  unreachable: [0x00],
};

/** Packed ABI return value for an output at `ptr` of `len` bytes. */
export const packed = (ptr: number, len: number): bigint => (BigInt(ptr) << 32n) | BigInt(len);

interface Hook {
  name: 'on_tool_call' | 'on_response';
  body: number[];
}

/** A plugin module: data segment at offset 16, `alloc` returning 4096, the given hooks; optional env.log import. */
export function wasmModule(opts: { data?: string; hooks: Hook[]; log?: boolean }): Uint8Array {
  const types = [
    [0x60, ...vec([[I32]]), ...vec([[I32]])], // 0: (i32) -> i32
    [0x60, ...vec([[I32], [I32]]), ...vec([[I64]])], // 1: (i32, i32) -> i64
    [0x60, ...vec([[I32], [I32]]), ...vec([])], // 2: (i32, i32) -> ()
  ];
  const imports = opts.log ? [[...str('env'), ...str('log'), 0x00, ...uleb(2)]] : [];
  const base = imports.length; // function index of alloc
  const funcs = [[...uleb(0)], ...opts.hooks.map(() => [...uleb(1)])];
  const exports = [
    [...str('memory'), 0x02, 0x00],
    [...str('alloc'), 0x00, ...uleb(base)],
    ...opts.hooks.map((h, i) => [...str(h.name), 0x00, ...uleb(base + 1 + i)]),
  ];
  const code = [
    [0x00, ...op.i32(4096), 0x0b],
    ...opts.hooks.map((h) => [0x00, ...h.body, 0x0b]),
  ].map((b) => [...uleb(b.length), ...b]);
  const data = opts.data ? [[0x00, ...op.i32(16), 0x0b, ...uleb(Buffer.byteLength(opts.data)), ...Buffer.from(opts.data)]] : [];
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, vec(types)),
    ...(imports.length ? section(2, vec(imports)) : []),
    ...section(3, vec(funcs)),
    ...section(5, vec([[0x00, 0x01]])),
    ...section(7, vec(exports)),
    ...section(10, vec(code)),
    ...(data.length ? section(11, vec(data)) : []),
  ]);
}

const fixed = (json: string, name: Hook['name'] = 'on_tool_call') =>
  wasmModule({ data: json, hooks: [{ name, body: op.i64(packed(16, Buffer.byteLength(json))) }] });

/** Rewrites every call's arguments to `{"rewritten":true}`. */
export const rewriteWasm = () => fixed('{"arguments":{"rewritten":true}}');
/** Refuses every call. */
export const denyWasm = () => fixed('{"deny":"blocked by wasm policy"}');
/** Answers without contacting the server. */
export const respondWasm = () => fixed('{"respond":{"content":[{"type":"text","text":"from wasm"}]}}');
/** Replaces successful results. */
export const responseWasm = () => fixed('{"result":{"content":[{"type":"text","text":"filtered by wasm"}]}}', 'on_response');
/** Returns garbage. */
export const badJsonWasm = () => fixed('not json');
/** Never returns. */
export const loopWasm = () => wasmModule({ hooks: [{ name: 'on_tool_call', body: [...op.loopForever, ...op.i64(0n)] }] });
/** Grows its memory by 64 pages (4 MiB) per call. */
export const growWasm = () => wasmModule({ hooks: [{ name: 'on_tool_call', body: [...op.i32(64), ...op.grow, ...op.drop, ...op.i64(0n)] }] });
/** Traps. */
export const trapWasm = () => wasmModule({ hooks: [{ name: 'on_tool_call', body: [...op.unreachable, ...op.i64(0n)] }] });
/** Logs "hello from wasm" and continues. */
export const logWasm = () => {
  const msg = 'hello from wasm';
  return wasmModule({ log: true, data: msg, hooks: [{ name: 'on_tool_call', body: [...op.i32(16), ...op.i32(msg.length), ...op.call(0), ...op.i64(0n)] }] });
};
/** Per-instance counter: arguments become `{"n":"<k>"}` where k counts this instance's calls (single digit). */
export const counterWasm = () => {
  const json = '{"arguments":{"n":"0"}}';
  const at = 16 + json.indexOf('"0"') + 1;
  return wasmModule({
    data: json,
    hooks: [{ name: 'on_tool_call', body: [...op.i32(at), ...op.i32(at), ...op.load8, ...op.i32(1), ...op.add, ...op.store8, ...op.i64(packed(16, json.length))] }],
  });
};

// ─── 7.9: plugin API v5 component ABI (core module of a `mcp-gateway:plugin@5.0.0` component) ───────────────────

export const COMPONENT_HOOK = { on_tool_call: 'mcp-gateway:plugin/hooks@5.0.0#on-tool-call', on_response: 'mcp-gateway:plugin/hooks@5.0.0#on-response' } as const;

/**
 * A component-ABI module: `memory`, `cabi_realloc` (returns 4096) and one hook returning a fixed `option<string>`
 * (`json` = some(json), `undefined` = none). Retarea at 16, string at 32.
 */
export function componentModule(hook: keyof typeof COMPONENT_HOOK, json: string | undefined, opts: { post?: boolean } = {}): Uint8Array {
  const types = [
    [0x60, ...vec([[I32], [I32], [I32], [I32]]), ...vec([[I32]])], // 0: cabi_realloc
    [0x60, ...vec([[I32], [I32]]), ...vec([[I32]])], // 1: hook
    [0x60, ...vec([[I32]]), ...vec([])], // 2: cabi_post
  ];
  const le = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
  const len = json === undefined ? 0 : Buffer.byteLength(json);
  const ret = [json === undefined ? 0 : 1, 0, 0, 0, ...le(32), ...le(len)];
  const blob = [...ret, ...new Array(32 - 16 - ret.length).fill(0), ...(json === undefined ? [] : [...Buffer.from(json)])];
  const funcs = [[...uleb(0)], [...uleb(1)], ...(opts.post ? [[...uleb(2)]] : [])];
  const exports = [
    [...str('memory'), 0x02, 0x00],
    [...str('cabi_realloc'), 0x00, ...uleb(0)],
    [...str(COMPONENT_HOOK[hook]), 0x00, ...uleb(1)],
    ...(opts.post ? [[...str(`cabi_post_${COMPONENT_HOOK[hook]}`), 0x00, ...uleb(2)]] : []),
  ];
  const code = [[0x00, ...op.i32(4096), 0x0b], [0x00, ...op.i32(16), 0x0b], ...(opts.post ? [[0x00, 0x0b]] : [])].map((b) => [...uleb(b.length), ...b]);
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, vec(types)),
    ...section(3, vec(funcs)),
    ...section(5, vec([[0x00, 0x01]])),
    ...section(7, vec(exports)),
    ...section(10, vec(code)),
    ...section(11, vec([[0x00, ...op.i32(16), 0x0b, ...uleb(blob.length), ...blob]])),
  ]);
}
