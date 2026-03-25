import init, { WfcEngine } from "../wasm/wfc_core.js";
import type { WorkerRequest, WorkerResponse } from "./types.js";

let engine: WfcEngine | null = null;
let currentSeed = 0;

function post(msg: WorkerResponse): void {
  self.postMessage(msg);
}

async function initialize(seed: number): Promise<void> {
  // In a worker, import.meta.url resolves to the worker script URL.
  // The WASM binary is co-located with the JS glue.
  await init();
  engine = new WfcEngine();
  currentSeed = seed;
  post({ type: "ready" });
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
  } catch (e) {
    post({ type: "error", id, message: String(e) });
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
  } catch (e) {
    post({ type: "error", id, message: String(e) });
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
  } catch (e) {
    post({ type: "error", id, message: String(e) });
  }
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;

  switch (msg.type) {
    case "init":
      initialize(msg.seed);
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
