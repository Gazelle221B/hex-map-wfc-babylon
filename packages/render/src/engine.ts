import { WebGPUEngine } from "@babylonjs/core";

export type WebGpuInitErrorKind = "unsupported" | "adapterUnavailable" | "initFailed";

function defaultUserMessage(kind: WebGpuInitErrorKind): string {
  switch (kind) {
    case "unsupported":
      return "WebGPU is not available in this browser. Use a recent Chromium-based browser with WebGPU enabled.";
    case "adapterUnavailable":
      return "WebGPU is available, but no compatible GPU adapter could be opened. Check browser settings and GPU drivers, then reload.";
    case "initFailed":
      return "Babylon could not initialize WebGPU for this scene. Reload the page and try again.";
  }
}

export class WebGpuInitError extends Error {
  readonly kind: WebGpuInitErrorKind;
  readonly userMessage: string;

  constructor(
    kind: WebGpuInitErrorKind,
    message: string,
    userMessage = defaultUserMessage(kind),
  ) {
    super(message);
    this.name = "WebGpuInitError";
    this.kind = kind;
    this.userMessage = userMessage;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function errorDetails(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function createEngine(canvas: HTMLCanvasElement): Promise<WebGPUEngine> {
  if (!("gpu" in navigator) || !navigator.gpu) {
    throw new WebGpuInitError(
      "unsupported",
      "navigator.gpu is not available in this browser.",
    );
  }

  let adapter: GPUAdapter | null = null;
  let adapterError: unknown;

  try {
    adapter = (await navigator.gpu.requestAdapter({ powerPreference: "high-performance" })) ?? null;
  } catch (error) {
    adapterError = error;
  }

  if (!adapter) {
    try {
      adapter = (await navigator.gpu.requestAdapter()) ?? null;
    } catch (error) {
      adapterError ??= error;
    }
  }

  if (!adapter) {
    const details = adapterError
      ? ` Failed to request adapter: ${errorDetails(adapterError)}`
      : "";
    throw new WebGpuInitError(
      "adapterUnavailable",
      `No WebGPU adapter was available.${details}`,
    );
  }

  const engine = new WebGPUEngine(canvas, {
    antialias: true,
    adaptToDeviceRatio: true,
  });

  try {
    await engine.initAsync();
    return engine;
  } catch (error) {
    engine.dispose();
    throw new WebGpuInitError(
      "initFailed",
      `Failed to initialize Babylon WebGPUEngine: ${errorDetails(error)}`,
    );
  }
}
