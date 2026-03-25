import type { GridResult } from "./cell.js";
import type { MapConfig } from "./config.js";

/**
 * Events emitted by the WFC solver.
 */
export interface WfcEvents {
  readonly onGridSolved: (result: GridResult) => void;
  readonly onAllSolved: (results: readonly GridResult[]) => void;
  readonly onProgress: (gridIndex: number, phase: string) => void;
  readonly onError: (error: { readonly message: string; readonly gridIndex?: number }) => void;
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
