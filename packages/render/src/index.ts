import type { Camera, Scene } from "@babylonjs/core";
import type {
  GridResult,
  MapConfig,
  PlacementItem,
  RenderEvents,
} from "@hex/types";
import { createCamera } from "./camera.js";
import { createEngine } from "./engine.js";
import { GridMeshLayer } from "./grid-mesh.js";
import { PlacementMeshLayer } from "./placement-mesh.js";
import { createScene } from "./scene.js";
import { createTilePool } from "./tile-pool.js";

export interface HexRenderer {
  addGrid(result: GridResult): void;
  addPlacements(items: readonly PlacementItem[]): void;
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

  const tilePool = createTilePool(scene);
  const gridLayer = new GridMeshLayer(tilePool);
  const placementLayer = new PlacementMeshLayer(scene);

  const resize = () => engine.resize();
  window.addEventListener("resize", resize);
  engine.runRenderLoop(() => {
    scene.render();
  });

  return {
    addGrid(result) {
      gridLayer.addGrid(result);
    },
    addPlacements(items) {
      placementLayer.addPlacements(items);
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
        queueMicrotask(() => events.onReady?.());
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
