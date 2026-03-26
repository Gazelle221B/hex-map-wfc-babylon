export type WorkerFatalPhase = "init" | "runtime";

/** Messages sent to the WFC worker. */
export type WorkerRequest =
  | { type: "init"; seed: number }
  | { type: "solve"; id: string; gridQ: number; gridR: number; tileTypes?: number[] }
  | { type: "solveAll"; id: string; seed: number }
  | { type: "placements"; id: string; gridQ: number; gridR: number; seed: number; offsetX: number; offsetZ: number }
  | { type: "reset" };

/** Messages sent from the WFC worker. */
export type WorkerResponse =
  | { type: "ready" }
  | { type: "result"; id: string; data: SolveResultData }
  | { type: "allResults"; id: string; data: SolveResultData[] }
  | { type: "placements"; id: string; data: PlacementData[] }
  | { type: "fatal"; phase: WorkerFatalPhase; message: string }
  | { type: "error"; id: string; message: string };

/** A single tile in the solve result. */
export interface TileData {
  readonly q: number;
  readonly r: number;
  readonly s: number;
  readonly tile_id: number;
  readonly rotation: number;
  readonly level: number;
}

/** Result of solving a single grid. */
export interface SolveResultData {
  readonly success: boolean;
  readonly tiles: readonly TileData[];
  readonly collapse_order: readonly TileData[];
  readonly changed_fixed_cells: readonly TileData[];
  readonly dropped_count: number;
  readonly backtracks: number;
  readonly tries: number;
  readonly local_wfc_attempts: number;
}

/** A decoration placement. */
export interface PlacementData {
  readonly placement_type: number;
  readonly tier: number;
  readonly world_x: number;
  readonly world_y: number;
  readonly world_z: number;
  readonly rotation: number;
  readonly tile_q: number;
  readonly tile_r: number;
  readonly tile_level: number;
}
