import {
  Color3,
  Color4,
  DirectionalLight,
  HemisphericLight,
  Scene,
  Vector3,
  type WebGPUEngine,
} from "@babylonjs/core";

export interface SceneBundle {
  readonly scene: Scene;
  readonly sunLight: DirectionalLight;
  readonly fillLight: HemisphericLight;
}

export function createScene(engine: WebGPUEngine): SceneBundle {
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.91, 0.95, 0.98, 1);
  scene.ambientColor = new Color3(0.55, 0.58, 0.62);

  const fillLight = new HemisphericLight("fill-light", new Vector3(0.2, 1, 0.1), scene);
  fillLight.intensity = 0.75;
  fillLight.groundColor = new Color3(0.36, 0.34, 0.31);

  const sunLight = new DirectionalLight("sun-light", new Vector3(-0.6, -1, 0.35), scene);
  sunLight.position = new Vector3(18, 36, -20);
  sunLight.intensity = 1.35;

  return {
    scene,
    sunLight,
    fillLight,
  };
}
