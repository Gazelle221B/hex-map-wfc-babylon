import init, { WfcEngine } from "../wasm/wfc_core.js";
import type { WorkerFatalPhase, WorkerRequest, WorkerResponse } from "./types.js";

let engine: WfcEngine | null = null;
let currentSeed = 0;

function post(msg: WorkerResponse): void {
  self.postMessage(msg);
}

function postFatal(phase: WorkerFatalPhase, message: string): void {
  post({ type: "fatal", phase, message });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function initialize(seed: number): Promise<void> {
  const previousEngine = engine;

  try {
    // In a worker, import.meta.url resolves to the worker script URL.
    // The WASM binary is co-located with the JS glue.
    await init();
    const nextEngine = new WfcEngine();
    previousEngine?.free();
    engine = nextEngine;
    currentSeed = seed;
    post({ type: "ready" });
  } catch (error) {
    previousEngine?.free();
    engine = null;
    postFatal("init", `Failed to initialize the WASM worker: ${errorMessage(error)}`);
  }
}

function handleSolve(id: string, gridQ: number, gridR: number, tileTypes?: number[]): void {
  if (!engine) {
    post({ type: "error", id, message: "engine not initialized" });
    return;
  }

  try {
    const options = {
      seed: BigInt(currentSeed),
      grid_q: gridQ,
      grid_r: gridR,
      tile_types: tileTypes ?? null,
    };
    const result = engine.solve_grid(options);
    post({ type: "result", id, data: result });
  } catch (error) {
    post({ type: "error", id, message: errorMessage(error) });
  }
}

function handleSolveAll(id: string, seed: number): void {
  if (!engine) {
    post({ type: "error", id, message: "engine not initialized" });
    return;
  }

  try {
    engine.reset();
    currentSeed = seed;
    const results = engine.solve_all(BigInt(seed));
    post({ type: "allResults", id, data: results });
  } catch (error) {
    post({ type: "error", id, message: errorMessage(error) });
  }
}

function handlePlacements(
  id: string,
  gridQ: number,
  gridR: number,
  seed: number,
  offsetX: number,
  offsetZ: number,
): void {
  if (!engine) {
    post({ type: "error", id, message: "engine not initialized" });
    return;
  }

  try {
    const data = engine.generate_placements(gridQ, gridR, BigInt(seed), offsetX, offsetZ);
    post({ type: "placements", id, data });
  } catch (error) {
    post({ type: "error", id, message: errorMessage(error) });
  }
}

self.addEventListener("error", (event) => {
  postFatal("runtime", event.message || "The WFC worker encountered an unhandled error.");
});

self.addEventListener("unhandledrejection", (event) => {
  postFatal("runtime", `Unhandled worker promise rejection: ${errorMessage(event.reason)}`);
});

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;

  switch (msg.type) {
    case "init":
      void initialize(msg.seed);
      break;
    case "solve":
      handleSolve(msg.id, msg.gridQ, msg.gridR, msg.tileTypes);
      break;
    case "solveAll":
      handleSolveAll(msg.id, msg.seed);
      break;
    case "placements":
      handlePlacements(msg.id, msg.gridQ, msg.gridR, msg.seed, msg.offsetX, msg.offsetZ);
      break;
    case "reset":
      engine?.reset();
      break;
  }
};
