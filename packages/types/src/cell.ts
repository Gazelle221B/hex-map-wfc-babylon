/**
 * A single collapsed cell result from the WFC solver.
 * Uses cube coordinates (q + r + s = 0).
 */
export interface CellResult {
  readonly q: number;
  readonly r: number;
  readonly s: number;
  readonly tileId: number;
  readonly rotation: number; // 0-5 (60° steps)
  readonly elevation: number; // 0-4
  readonly worldX: number;
  readonly worldY: number;
  readonly worldZ: number;
}

/**
 * Result of solving a single hex grid.
 */
export interface GridResult {
  readonly gridIndex: number;
  readonly cells: readonly CellResult[];
}

export type PackedGridStatus = "solved" | "fallback_water";

export const PACKED_GRID_STRIDE = 5;

/**
 * Packed cell payload emitted from the worker.
 * Stride: [q, r, tileId, rotation, level]
 */
export interface PackedGridChunk {
  readonly gridIndex: number;
  readonly status: PackedGridStatus;
  readonly cells: Int32Array;
}
