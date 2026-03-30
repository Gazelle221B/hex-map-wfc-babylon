import { createRenderer, type HexRenderer } from "@hex/render";
import { DEFAULT_CONFIG, HEX_WIDTH, type MapConfig } from "@hex/types";
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
    focusCameraForCenterBoot(renderer, config);

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
        statusElement.textContent =
          `Completed with ${summary.fallbackCount} fallback grids and ${summary.failedCount} failed grids`;
      },
    });

    const camera = renderer.getCamera();
    zoomElement.textContent = `Camera radius: ${
      isArcRotateCamera(camera)
        ? camera.radius.toFixed(1)
        : ((config.cameraMinDistance + config.cameraMaxDistance) / 2).toFixed(1)
    }`;

    renderer.clear();
    statusElement.textContent = `Solving ${config.buildMode}…`;
    const summary = config.buildMode === "single-pass"
      ? await wfc.buildAllSinglePass(config.seed, config.wfcMode)
      : await wfc.buildAllProgressively(config.seed, config.wfcMode);
    statusElement.textContent = `Ready (${summary.solvedCount} solved, ${summary.fallbackCount} fallback, ${summary.failedCount} failed)`;

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

function focusCameraForCenterBoot(renderer: HexRenderer, config: MapConfig): void {
  const camera = renderer.getCamera();
  if (!isArcRotateCamera(camera)) {
    return;
  }

  const size = HEX_WIDTH / 2;
  const gridWorldRadius = Math.sqrt(3) * (config.gridRadius + 1) * size;
  const fov = (config.cameraFov * Math.PI) / 180;
  const fitRadius = (gridWorldRadius / Math.sin(fov / 2)) * 1.25;
  camera.radius = Math.min(config.cameraMaxDistance, Math.max(config.cameraMinDistance, fitRadius));
}

function isArcRotateCamera(camera: ReturnType<HexRenderer["getCamera"]>): camera is ReturnType<
  HexRenderer["getCamera"]
> & {
  radius: number;
} {
  return "radius" in camera && typeof camera.radius === "number";
}
