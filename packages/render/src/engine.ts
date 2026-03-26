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

function isAdapterUnavailableError(error: unknown): boolean {
  const message = errorDetails(error).toLowerCase();
  const adapterRequestPhrases = [
    "requestadapter",
    "request adapter",
    "failed to request adapter",
    "unable to request adapter",
    "could not request adapter",
    "could not retrieve a webgpu adapter",
    "no adapter",
    "no compatible adapter",
    "no compatible gpu adapter",
    "adapter is null",
  ];
  return adapterRequestPhrases.some((phrase) => message.includes(phrase));
}

export async function createEngine(canvas: HTMLCanvasElement): Promise<WebGPUEngine> {
  if (!("gpu" in navigator) || !navigator.gpu) {
    throw new WebGpuInitError(
      "unsupported",
      "navigator.gpu is not available in this browser.",
    );
  }

  const engine = new WebGPUEngine(canvas, {
    antialias: true,
    adaptToDeviceRatio: true,
    powerPreference: "high-performance",
  });

  try {
    await engine.initAsync();
    return engine;
  } catch (error) {
    engine.dispose();

    if (isAdapterUnavailableError(error)) {
      throw new WebGpuInitError(
        "adapterUnavailable",
        `No WebGPU adapter was available. Failed to request adapter: ${errorDetails(error)}`,
      );
    }

    throw new WebGpuInitError(
      "initFailed",
      `Failed to initialize Babylon WebGPUEngine: ${errorDetails(error)}`,
    );
  }
}
