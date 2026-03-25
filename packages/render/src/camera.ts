import { ArcRotateCamera, Vector3, type Scene } from "@babylonjs/core";
import type { MapConfig } from "@hex/types";

export interface CameraController {
  readonly camera: ArcRotateCamera;
  updateConfig(config: Partial<MapConfig>): void;
  dispose(): void;
}

export function createCamera(
  canvas: HTMLCanvasElement,
  scene: Scene,
  config: MapConfig,
  onZoomChanged: (zoom: number) => void,
): CameraController {
  const camera = new ArcRotateCamera(
    "hex-camera",
    -Math.PI / 4,
    Math.min(Math.PI / 3, config.cameraMaxPolarAngle),
    (config.cameraMinDistance + config.cameraMaxDistance) / 2,
    new Vector3(0, 0, 0),
    scene,
  );

  camera.attachControl(canvas, true);
  camera.fov = (config.cameraFov * Math.PI) / 180;
  camera.lowerRadiusLimit = config.cameraMinDistance;
  camera.upperRadiusLimit = config.cameraMaxDistance;
  camera.upperBetaLimit = config.cameraMaxPolarAngle;
  camera.minZ = 0.1;
  camera.maxZ = config.cameraMaxDistance * 8;
  camera.wheelDeltaPercentage = 0.02;
  camera.panningSensibility = 0;

  let lastRadius = camera.radius;
  let observer: ReturnType<typeof camera.onViewMatrixChangedObservable.add> | null =
    camera.onViewMatrixChangedObservable.add(() => {
      if (Math.abs(camera.radius - lastRadius) > 0.001) {
        lastRadius = camera.radius;
        onZoomChanged(lastRadius);
      }
    });

  return {
    camera,
    updateConfig(nextConfig) {
      if (nextConfig.cameraFov !== undefined) {
        camera.fov = (nextConfig.cameraFov * Math.PI) / 180;
      }
      if (nextConfig.cameraMinDistance !== undefined) {
        camera.lowerRadiusLimit = nextConfig.cameraMinDistance;
      }
      if (nextConfig.cameraMaxDistance !== undefined) {
        camera.upperRadiusLimit = nextConfig.cameraMaxDistance;
        camera.maxZ = nextConfig.cameraMaxDistance * 8;
      }
      if (nextConfig.cameraMaxPolarAngle !== undefined) {
        camera.upperBetaLimit = nextConfig.cameraMaxPolarAngle;
        camera.beta = Math.min(camera.beta, nextConfig.cameraMaxPolarAngle);
      }
    },
    dispose() {
      if (observer) {
        camera.onViewMatrixChangedObservable.remove(observer);
        observer = null;
      }
      camera.detachControl();
      camera.dispose();
    },
  };
}
