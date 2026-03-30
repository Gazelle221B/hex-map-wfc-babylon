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

export interface CoordResult {
  readonly q: number;
  readonly r: number;
  readonly s: number;
}

export interface GridConflict {
  readonly failedQ: number;
  readonly failedR: number;
  readonly failedS: number;
  readonly sourceQ?: number;
  readonly sourceR?: number;
  readonly sourceS?: number;
  readonly dir?: number;
}

export interface GridSolveStats {
  readonly backtracks: number;
  readonly tries: number;
  readonly localWfcAttempts: number;
  readonly droppedCount: number;
}

/**
 * Result of solving a single hex grid.
 */
export interface GridResult {
  readonly gridIndex: number;
  readonly status: PackedGridStatus;
  readonly cells: readonly CellResult[];
  readonly collapseOrder: readonly CellResult[];
  readonly changedFixedCells: readonly CellResult[];
  readonly unfixedCells: readonly CoordResult[];
  readonly droppedCells: readonly CoordResult[];
  readonly lastConflict: GridConflict | null;
  readonly neighborConflict: GridConflict | null;
  readonly stats: GridSolveStats;
}

export type PackedGridStatus = "solved" | "failed" | "fallback_water";

export const PACKED_GRID_STRIDE = 5;
export const PACKED_COORD_STRIDE = 3;

/**
 * Packed cell payload emitted from the worker.
 * Stride: [q, r, tileId, rotation, level]
 */
export interface PackedGridChunk {
  readonly gridIndex: number;
  readonly status: PackedGridStatus;
  readonly cells: Int32Array;
  readonly collapseOrder: Int32Array;
  readonly changedFixedCells: Int32Array;
  readonly unfixedCells: Int32Array;
  readonly droppedCells: Int32Array;
  readonly lastConflict: GridConflict | null;
  readonly neighborConflict: GridConflict | null;
  readonly stats: GridSolveStats;
}
