/* tslint:disable */
/* eslint-disable */

/**
 * The WFC engine, holding global state across multiple grid solves.
 */
export class WfcEngine {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Generate placements for a solved grid.
     */
    generate_placements(grid_q: number, grid_r: number, seed: bigint, offset_x: number, offset_z: number): any;
    /**
     * Get the number of cells in the global map.
     */
    global_cell_count(): number;
    /**
     * Create a new WFC engine.
     */
    constructor();
    /**
     * Reset the engine, clearing all global state.
     */
    reset(): void;
    /**
     * Solve all 19 grids in order (center first, then outward).
     * Returns an array of JsSolveResult.
     */
    solve_all(seed: bigint): any;
    /**
     * Solve a single grid at the given position.
     * Returns a JsSolveResult via serde_wasm_bindgen.
     */
    solve_grid(options: any): any;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_wfcengine_free: (a: number, b: number) => void;
    readonly wfcengine_generate_placements: (a: number, b: number, c: number, d: number, e: bigint, f: number, g: number) => void;
    readonly wfcengine_global_cell_count: (a: number) => number;
    readonly wfcengine_new: () => number;
    readonly wfcengine_reset: (a: number) => void;
    readonly wfcengine_solve_all: (a: number, b: number, c: bigint) => void;
    readonly wfcengine_solve_grid: (a: number, b: number, c: number) => void;
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
