import init, { WfcEngine } from "../wasm/wfc_core.js";
import {
  WFC_PROTOCOL_VERSION,
  type PackedSinglePassResult,
  type PackedSolveResult,
  type WorkerFatalPhase,
  type WorkerRequest,
  type WorkerResponse,
} from "./types.js";

let engine: WfcEngine | null = null;

type TransferPostingScope = {
  postMessage(message: WorkerResponse, transfer: Transferable[]): void;
};

function post(message: WorkerResponse, transfer: Transferable[] = []): void {
  (self as unknown as TransferPostingScope).postMessage(message, transfer);
}

function postFatal(phase: WorkerFatalPhase, message: string): void {
  post({ type: "fatal", phase, message });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function initialize(): Promise<void> {
  const previousEngine = engine;
  try {
    await init();
    engine = new WfcEngine();
    previousEngine?.free();
    post({ type: "ready" });
  } catch (error) {
    previousEngine?.free();
    engine = null;
    postFatal("init", `Failed to initialize the WASM worker: ${errorMessage(error)}`);
  }
}

function handleGridSolve(
  id: string,
  gridQ: number,
  gridR: number,
  seed: number,
  tileTypes: number[] | undefined,
  wfcMode: "legacy-compat" | "modern-fast",
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
      wfc_mode: wfcMode,
    };
    const result = engine.solve_grid_packed(options) as PackedSolveResult;
    post(
      { type: "result", id, data: result },
      [
        result.cells.buffer,
        result.collapse_order.buffer,
        result.changed_fixed_cells.buffer,
        result.unfixed_cells.buffer,
        result.dropped_cells.buffer,
      ],
    );
  } catch (error) {
    post({ type: "error", id, message: errorMessage(error) });
  }
}

function handleSinglePassSolve(
  id: string,
  seed: number,
  tileTypes: number[] | undefined,
  wfcMode: "legacy-compat" | "modern-fast",
): void {
  if (!engine) {
    post({ type: "error", id, message: "engine not initialized" });
    return;
  }

  try {
    const options = {
      seed: BigInt(seed),
      tile_types: tileTypes ?? null,
      wfc_mode: wfcMode,
    };
    const result = engine.solve_all_single_pass_packed(options) as PackedSinglePassResult;
    post(
      { type: "singlePassResult", id, data: result },
      [result.cells.buffer, result.collapse_order.buffer],
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
  const message = event.data;
  switch (message.type) {
    case "init":
      if (message.protocolVersion !== WFC_PROTOCOL_VERSION) {
        postFatal(
          "init",
          `Protocol version mismatch: expected ${WFC_PROTOCOL_VERSION}, got ${message.protocolVersion}.`,
        );
        break;
      }
      void initialize();
      break;
    case "solve":
      handleGridSolve(message.id, message.gridQ, message.gridR, message.seed, message.tileTypes, message.wfcMode);
      break;
    case "solveAllSinglePass":
      handleSinglePassSolve(message.id, message.seed, message.tileTypes, message.wfcMode);
      break;
    case "placements":
      handlePlacements(message.id, message.gridQ, message.gridR, message.seed, message.offsetX, message.offsetZ);
      break;
    case "reset":
      engine?.reset();
      break;
  }
};
