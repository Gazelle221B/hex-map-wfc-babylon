import type { PackedGridChunk } from "./cell.js";
import type { MapConfig } from "./config.js";
import type { PackedPlacementChunk } from "./placement.js";

export interface BuildProgress {
  readonly phase: "solving" | "placements";
  readonly completed: number;
  readonly total: number;
  readonly gridIndex: number;
  readonly fallbackCount: number;
}

export interface BuildSummary {
  readonly totalGrids: number;
  readonly solvedCount: number;
  readonly fallbackCount: number;
}

/**
 * Events emitted by the WFC solver.
 */
export interface WfcEvents {
  readonly onGridSolved: (chunk: PackedGridChunk) => void;
  readonly onPlacementsGenerated: (chunk: PackedPlacementChunk) => void;
  readonly onAllSolved: (summary: BuildSummary) => void;
  readonly onProgress: (progress: BuildProgress) => void;
  readonly onError: (error: { readonly message: string; readonly gridIndex?: number; readonly recoverable: boolean }) => void;
}

/**
 * Events emitted by the renderer.
 */
export interface RenderEvents {
  readonly onReady: () => void;
  readonly onCameraChanged: (zoom: number) => void;
}

/**
 * Events emitted by the UI panel.
 */
export interface UiEvents {
  readonly onConfigChanged: <K extends keyof MapConfig>(
    key: K,
    value: MapConfig[K],
  ) => void;
  readonly onBuildRequested: (seed: number) => void;
  readonly onBuildAllRequested: (seed: number) => void;
}
