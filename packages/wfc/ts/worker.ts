import init, { WfcEngine } from "../wasm/wfc_core.js";
import type {
  PackedSolveResult,
  WorkerFatalPhase,
  WorkerRequest,
  WorkerResponse,
} from "./types.js";

let engine: WfcEngine | null = null;

function post(msg: WorkerResponse, transfer: Transferable[] = []): void {
  self.postMessage(msg, { transfer });
}

function postFatal(phase: WorkerFatalPhase, message: string): void {
  post({ type: "fatal", phase, message });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function initialize(seed: number): Promise<void> {
  void seed;
  const previousEngine = engine;

  try {
    // In a worker, import.meta.url resolves to the worker script URL.
    // The WASM binary is co-located with the JS glue.
    await init();
    const nextEngine = new WfcEngine();
    previousEngine?.free();
    engine = nextEngine;
    post({ type: "ready" });
  } catch (error) {
    previousEngine?.free();
    engine = null;
    postFatal("init", `Failed to initialize the WASM worker: ${errorMessage(error)}`);
  }
}

function handleSolve(
  id: string,
  gridQ: number,
  gridR: number,
  seed: number,
  tileTypes?: number[],
): void {
  if (!engine) {
    post({ type: "error", id, message: "engine not initialized" });
    return;
  }

  try {
    const options = {
      seed: BigInt(seed),
      grid_q: gridQ,
      grid_r: gridR,
      tile_types: tileTypes ?? null,
    };
    const result = engine.solve_grid_packed(options) as PackedSolveResult;
    post(
      { type: "result", id, data: result },
      [result.cells.buffer],
    );
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
    const data = engine.generate_placements_packed(gridQ, gridR, BigInt(seed), offsetX, offsetZ);
    post({ type: "placements", id, data }, [data.buffer]);
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
      handleSolve(msg.id, msg.gridQ, msg.gridR, msg.seed, msg.tileTypes);
      break;
    case "placements":
      handlePlacements(msg.id, msg.gridQ, msg.gridR, msg.seed, msg.offsetX, msg.offsetZ);
      break;
    case "reset":
      engine?.reset();
      break;
  }
};
