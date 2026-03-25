import { createRenderer } from "@hex/render";
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
  const renderer = await createRenderer(canvas, config);
  const wfc = new WfcBridge(config.seed);

  const unsubscribe = renderer.subscribe({
    onReady: () => {
      statusElement.textContent = "Renderer ready. Preparing WFC worker…";
    },
    onCameraChanged: (zoom) => {
      zoomElement.textContent = `Camera radius: ${zoom.toFixed(1)}`;
    },
  });

  await wfc.ready();
  zoomElement.textContent = `Camera radius: ${((config.cameraMinDistance + config.cameraMaxDistance) / 2).toFixed(1)}`;

  statusElement.textContent = "Solving 19 grids in WebAssembly… this can take a while.";
  const grids = await wfc.solveAll(config.seed);

  statusElement.textContent = "Generating placements…";
  const placements = await wfc.generatePlacements(grids, config.seed);

  renderer.clear();
  for (const grid of grids) {
    renderer.addGrid(grid);
  }
  renderer.addPlacements(placements);
  statusElement.textContent = `Rendered ${grids.length} grids and ${placements.length} placements.`;

  return {
    dispose() {
      unsubscribe();
      wfc.dispose();
      renderer.dispose();
    },
  };
}
