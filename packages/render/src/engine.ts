import { WebGPUEngine } from "@babylonjs/core";

export async function createEngine(canvas: HTMLCanvasElement): Promise<WebGPUEngine> {
  const engine = new WebGPUEngine(canvas, {
    antialias: true,
    adaptToDeviceRatio: true,
  });

  try {
    await engine.initAsync();
    return engine;
  } catch (error) {
    engine.dispose();
    const details = error instanceof Error ? error.message : String(error);
    throw new Error(`WebGPU is required to render this scene. Failed to initialize Babylon WebGPUEngine: ${details}`);
  }
}
