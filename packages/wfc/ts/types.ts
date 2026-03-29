import type {
  BuildProgress,
  BuildSummary,
  GridConflict,
  GridSolveStats,
  PackedGridChunk,
  PackedGridStatus,
  PackedPlacementChunk,
} from "@hex/types";

export const WFC_PROTOCOL_VERSION = 2;

export type WorkerFatalPhase = "init" | "runtime";
export type WfcMode = "legacy-compat" | "modern-fast";

export type WorkerRequest =
  | { type: "init"; protocolVersion: number }
  | { type: "solve"; id: string; gridQ: number; gridR: number; seed: number; tileTypes?: number[]; wfcMode: WfcMode }
  | { type: "solveAllSinglePass"; id: string; seed: number; tileTypes?: number[]; wfcMode: WfcMode }
  | { type: "placements"; id: string; gridQ: number; gridR: number; seed: number; offsetX: number; offsetZ: number }
  | { type: "reset" };

export type WorkerResponse =
  | { type: "ready" }
  | { type: "result"; id: string; data: PackedSolveResult }
  | { type: "singlePassResult"; id: string; data: PackedSinglePassResult }
  | { type: "placements"; id: string; data: Float32Array }
  | { type: "fatal"; phase: WorkerFatalPhase; message: string }
  | { type: "error"; id: string; message: string };

export interface PackedSolveResult {
  readonly status: PackedGridStatus;
  readonly cells: Int32Array;
  readonly collapse_order: Int32Array;
  readonly changed_fixed_cells: Int32Array;
  readonly unfixed_cells: Int32Array;
  readonly dropped_cells: Int32Array;
  readonly last_conflict: GridConflict | null;
  readonly neighbor_conflict: GridConflict | null;
  readonly backtracks: number;
  readonly tries: number;
  readonly local_wfc_attempts: number;
  readonly dropped_count: number;
}

export interface PackedSinglePassResult {
  readonly status: PackedGridStatus;
  readonly cells: Int32Array;
  readonly collapse_order: Int32Array;
  readonly last_conflict: GridConflict | null;
  readonly neighbor_conflict: GridConflict | null;
  readonly backtracks: number;
  readonly tries: number;
}

export interface TileData {
  readonly q: number;
  readonly r: number;
  readonly s: number;
  readonly tile_id: number;
  readonly rotation: number;
  readonly level: number;
}

export interface CoordData {
  readonly q: number;
  readonly r: number;
  readonly s: number;
}

export interface SolveResultData {
  readonly status: PackedGridStatus;
  readonly success: boolean;
  readonly tiles: readonly TileData[];
  readonly collapse_order: readonly TileData[];
  readonly changed_fixed_cells: readonly TileData[];
  readonly unfixed_cells: readonly CoordData[];
  readonly dropped_cells: readonly CoordData[];
  readonly last_conflict: GridConflict | null;
  readonly neighbor_conflict: GridConflict | null;
  readonly dropped_count: number;
  readonly backtracks: number;
  readonly tries: number;
  readonly local_wfc_attempts: number;
}

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

export type {
  BuildProgress,
  BuildSummary,
  GridSolveStats,
  PackedGridChunk,
  PackedPlacementChunk,
};
