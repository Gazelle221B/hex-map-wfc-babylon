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
