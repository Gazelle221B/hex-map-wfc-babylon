/* tslint:disable */
/* eslint-disable */

export class WfcEngine {
    free(): void;
    [Symbol.dispose](): void;
    debug_legacy_trace_grid_once(options: any): any;
    debug_legacy_trace_single_pass_once(options: any): any;
    generate_placements(grid_q: number, grid_r: number, seed: bigint, offset_x: number, offset_z: number): any;
    generate_placements_packed(grid_q: number, grid_r: number, seed: bigint, offset_x: number, offset_z: number): Float32Array;
    global_cell_count(): number;
    constructor();
    reset(): void;
    solve_all_single_pass(options: any): any;
    solve_all_single_pass_packed(options: any): any;
    solve_grid(options: any): any;
    solve_grid_packed(options: any): any;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_wfcengine_free: (a: number, b: number) => void;
    readonly wfcengine_debug_legacy_trace_grid_once: (a: number, b: number, c: number) => void;
    readonly wfcengine_debug_legacy_trace_single_pass_once: (a: number, b: number, c: number) => void;
    readonly wfcengine_generate_placements: (a: number, b: number, c: number, d: number, e: bigint, f: number, g: number) => void;
    readonly wfcengine_generate_placements_packed: (a: number, b: number, c: number, d: number, e: bigint, f: number, g: number) => void;
    readonly wfcengine_global_cell_count: (a: number) => number;
    readonly wfcengine_new: () => number;
    readonly wfcengine_reset: (a: number) => void;
    readonly wfcengine_solve_all_single_pass: (a: number, b: number, c: number) => void;
    readonly wfcengine_solve_all_single_pass_packed: (a: number, b: number, c: number) => void;
    readonly wfcengine_solve_grid: (a: number, b: number, c: number) => void;
    readonly wfcengine_solve_grid_packed: (a: number, b: number, c: number) => void;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export3: (a: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
