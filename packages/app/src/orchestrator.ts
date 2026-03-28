import { createRenderer, type HexRenderer } from "@hex/render";
import { DEFAULT_CONFIG, type MapConfig } from "@hex/types";
import { WfcBridge } from "@hex/wfc";

export interface BootHandle {
  dispose(): void;
}

export async function boot(
  canvas: HTMLCanvasElement,
  statusElement: HTMLElement,
  zoomElement: HTMLElement,
): Promise<BootHandle> {
  const config: MapConfig = { ...DEFAULT_CONFIG };
  let renderer: HexRenderer | null = null;
  let wfc: WfcBridge | null = null;
  let unsubscribeRenderer: (() => void) | null = null;
  let unsubscribeWfc: (() => void) | null = null;
  let disposed = false;

  const cleanup = (): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    unsubscribeRenderer?.();
    unsubscribeRenderer = null;
    unsubscribeWfc?.();
    unsubscribeWfc = null;
    wfc?.dispose();
    wfc = null;
    renderer?.dispose();
    renderer = null;
  };

  try {
    statusElement.textContent = "WebGPU check…";
    renderer = await createRenderer(canvas, config);

    statusElement.textContent = "WFC worker init…";
    wfc = new WfcBridge(config.seed);

    unsubscribeRenderer = renderer.subscribe({
      onCameraChanged: (zoom) => {
        zoomElement.textContent = `Camera radius: ${zoom.toFixed(1)}`;
      },
    });

    unsubscribeWfc = wfc.subscribe({
      onGridSolved: (chunk) => {
        renderer?.addPackedGrid(chunk);
      },
      onPlacementsGenerated: (chunk) => {
        renderer?.addPackedPlacements(chunk);
      },
      onProgress: (progress) => {
        if (progress.phase === "solving") {
          statusElement.textContent = `Solving ${progress.completed}/${progress.total}`;
          return;
        }

        statusElement.textContent = `Placements ${progress.completed}/${progress.total}`;
      },
      onError: (error) => {
        if (error.recoverable) {
          console.warn("Recoverable WFC issue:", error.message);
        }
      },
      onAllSolved: (summary) => {
        statusElement.textContent = `Completed with ${summary.fallbackCount} fallback grids`;
      },
    });

    zoomElement.textContent = `Camera radius: ${((config.cameraMinDistance + config.cameraMaxDistance) / 2).toFixed(1)}`;

    renderer.clear();
    await wfc.buildAllProgressively(config.seed);

    return {
      dispose() {
        cleanup();
      },
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}
