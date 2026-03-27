import type { Camera, Scene } from "@babylonjs/core";
import type {
  GridResult,
  MapConfig,
  PackedGridChunk,
  PackedPlacementChunk,
  PlacementItem,
  RenderEvents,
} from "@hex/types";
import { createCamera } from "./camera.js";
import { createEngine } from "./engine.js";
import { GridMeshLayer } from "./grid-mesh.js";
import { PlacementMeshLayer } from "./placement-mesh.js";
import { createScene } from "./scene.js";
import { createTilePool, type TilePool } from "./tile-pool.js";

export { WebGpuInitError } from "./engine.js";

export interface HexRenderer {
  addGrid(result: GridResult): void;
  addPackedGrid(chunk: PackedGridChunk): void;
  addPlacements(items: readonly PlacementItem[]): void;
  addPackedPlacements(chunk: PackedPlacementChunk): void;
  clear(): void;
  updateConfig(config: Partial<MapConfig>): void;
  subscribe(events: Partial<RenderEvents>): () => void;
  getScene(): Scene;
  getCamera(): Camera;
  dispose(): void;
}

export async function createRenderer(
  canvas: HTMLCanvasElement,
  config: MapConfig,
): Promise<HexRenderer> {
  const engine = await createEngine(canvas);
  const { scene } = createScene(engine);
  const subscriptions = new Set<Partial<RenderEvents>>();
  const emitCameraChanged = (zoom: number) => {
    for (const subscriber of subscriptions) {
      subscriber.onCameraChanged?.(zoom);
    }
  };

  const cameraController = createCamera(canvas, scene, config, emitCameraChanged);
  scene.activeCamera = cameraController.camera;

  let tilePool: TilePool | undefined;
  let gridLayer: GridMeshLayer | undefined;
  let placementLayer: PlacementMeshLayer | undefined;
  try {
    tilePool = createTilePool(scene);
    gridLayer = new GridMeshLayer(tilePool);
    placementLayer = new PlacementMeshLayer(scene);
  } catch (err) {
    gridLayer?.dispose();
    tilePool?.dispose();
    cameraController.dispose();
    scene.dispose();
    engine.dispose();
    throw err;
  }

  const resize = () => engine.resize();
  window.addEventListener("resize", resize);
  engine.runRenderLoop(() => {
    scene.render();
  });

  return {
    addGrid(result) {
      gridLayer.addGrid(result);
    },
    addPackedGrid(chunk) {
      gridLayer.addPackedGrid(chunk);
    },
    addPlacements(items) {
      placementLayer.addPlacements(items);
    },
    addPackedPlacements(chunk) {
      placementLayer.addPackedPlacements(chunk);
    },
    clear() {
      gridLayer.clear();
      placementLayer.clear();
    },
    updateConfig(nextConfig) {
      cameraController.updateConfig(nextConfig);
    },
    subscribe(events) {
      subscriptions.add(events);
      if (events.onReady) {
        queueMicrotask(() => {
          if (subscriptions.has(events)) {
            events.onReady?.();
          }
        });
      }
      return () => {
        subscriptions.delete(events);
      };
    },
    getScene() {
      return scene;
    },
    getCamera() {
      return cameraController.camera;
    },
    dispose() {
      window.removeEventListener("resize", resize);
      engine.stopRenderLoop();
      gridLayer.dispose();
      placementLayer.dispose();
      tilePool.dispose();
      cameraController.dispose();
      scene.dispose();
      engine.dispose();
      subscriptions.clear();
    },
  };
}
