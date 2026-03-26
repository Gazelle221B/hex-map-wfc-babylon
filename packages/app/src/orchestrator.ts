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
  let unsubscribe: (() => void) | null = null;
  let disposed = false;

  const cleanup = (): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    unsubscribe?.();
    unsubscribe = null;
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

    unsubscribe = renderer.subscribe({
      onCameraChanged: (zoom) => {
        zoomElement.textContent = `Camera radius: ${zoom.toFixed(1)}`;
      },
    });

    await wfc.ready();
    zoomElement.textContent = `Camera radius: ${((config.cameraMinDistance + config.cameraMaxDistance) / 2).toFixed(1)}`;

    statusElement.textContent = "Solve…";
    const grids = await wfc.solveAll(config.seed);

    statusElement.textContent = "Placements…";
    const placements = await wfc.generatePlacements(grids, config.seed);

    renderer.clear();
    for (const grid of grids) {
      renderer.addGrid(grid);
    }
    renderer.addPlacements(placements);
    statusElement.textContent = `Render complete: ${grids.length} grids and ${placements.length} placements.`;

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
