import type { CellResult, GridResult, PlacementItem, PlacementType } from "@hex/types";
import { HEX_WIDTH, LEVEL_HEIGHT } from "@hex/types";
import { WfcBridgeError } from "./errors.js";
import type {
  WorkerFatalPhase,
  WorkerRequest,
  WorkerResponse,
  SolveResultData,
  PlacementData,
} from "./types.js";
import { gridIndexToPosition, gridPositionToIndex } from "./grid-positions.js";

type PendingResolve<T> = {
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
};

/**
 * Bridge between the main thread and the WFC WASM worker.
 * Provides a Promise-based API for grid solving and placement generation.
 */
export class WfcBridge {
  private worker: Worker | null;
  private pending = new Map<string, PendingResolve<unknown>>();
  private readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (reason: Error) => void;
  private readySettled = false;
  private disposed = false;
  private terminalError: Error | null = null;
  private nextId = 0;

  constructor(seed: number) {
    this.worker = new Worker(
      new URL("./worker.ts", import.meta.url),
      { type: "module" },
    );

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });

    this.worker.addEventListener("message", this.onMessage);
    this.worker.addEventListener("error", this.onWorkerError);
    this.worker.addEventListener("messageerror", this.onWorkerMessageError);
    this.post({ type: "init", seed }, "init");
  }

  /** Wait for the WASM module to initialize. */
  async ready(): Promise<void> {
    return this.readyPromise;
  }

  /** Solve a single grid at the given hex-of-hex position. */
  async solveGrid(
    gridQ: number,
    gridR: number,
    tileTypes?: number[],
  ): Promise<GridResult> {
    const gridIndex = gridPositionToIndex(gridQ, gridR);
    const raw = await this.solveGridRaw(gridQ, gridR, tileTypes);
    return normalizeGridResult(assertSolveSucceeded(raw, gridIndex), gridIndex);
  }

  /** Solve all 19 grids. */
  async solveAll(seed: number): Promise<GridResult[]> {
    const rawResults = await this.solveAllRaw(seed);
    return rawResults.map((result, gridIndex) =>
      normalizeGridResult(assertSolveSucceeded(result, gridIndex), gridIndex),
    );
  }

  /** Generate placements for a solved set of grids. */
  async generatePlacements(
    grids: readonly GridResult[],
    seed: number,
  ): Promise<PlacementItem[]> {
    const placements = await Promise.all(
      grids.map(async (grid) => {
        const pos = gridIndexToPosition(grid.gridIndex);
        const raw = await this.generatePlacementsRaw(pos.q, pos.r, seed + grid.gridIndex, 0, 0);
        return raw.map(normalizePlacement);
      }),
    );
    return placements.flat();
  }

  private async solveGridRaw(
    gridQ: number,
    gridR: number,
    tileTypes?: number[],
  ): Promise<SolveResultData> {
    const id = this.genId();
    return this.request<SolveResultData>({
      type: "solve",
      id,
      gridQ,
      gridR,
      tileTypes,
    }, id);
  }

  private async solveAllRaw(seed: number): Promise<SolveResultData[]> {
    const id = this.genId();
    return this.request<SolveResultData[]>({
      type: "solveAll",
      id,
      seed,
    }, id);
  }

  private async generatePlacementsRaw(
    gridQ: number,
    gridR: number,
    seed: number,
    offsetX: number,
    offsetZ: number,
  ): Promise<PlacementData[]> {
    const id = this.genId();
    return this.request<PlacementData[]>({
      type: "placements",
      id,
      gridQ,
      gridR,
      seed,
      offsetX,
      offsetZ,
    }, id);
  }

  /** Reset the engine state. */
  reset(): void {
    if (this.disposed || this.terminalError) {
      return;
    }
    this.post({ type: "reset" }, "runtime");
  }

  /** Terminate the worker. */
  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    if (!this.terminalError) {
      this.terminalError = new WfcBridgeError("disposed", "The WFC worker was disposed.");
    }

    this.rejectReadyOnce(this.terminalError);
    this.rejectPending(this.terminalError);
    this.detachWorker(true);
  }

  private post(msg: WorkerRequest, phase: WorkerFatalPhase): void {
    if (!this.worker) {
      if (!this.terminalError) {
        this.handleFatal(phase, "The WFC worker is no longer available.");
      }
      return;
    }

    try {
      this.worker.postMessage(msg);
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      this.handleFatal(phase, `Failed to post a message to the WFC worker: ${details}`);
    }
  }

  private async request<T>(msg: WorkerRequest, id: string): Promise<T> {
    await this.ready();
    const worker = this.assertActiveWorker();

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      try {
        worker.postMessage(msg);
      } catch (error) {
        this.pending.delete(id);
        const details = error instanceof Error ? error.message : String(error);
        const terminalError = new WfcBridgeError(
          "fatal",
          `Failed to post a message to the WFC worker: ${details}`,
          { phase: "runtime" },
        );
        this.terminalError = terminalError;
        this.rejectReadyOnce(terminalError);
        this.rejectPending(terminalError);
        this.detachWorker(true);
        reject(terminalError);
      }
    });
  }

  private genId(): string {
    return String(++this.nextId);
  }

  private onMessage = (event: MessageEvent<WorkerResponse>): void => {
    const msg = event.data;

    switch (msg.type) {
      case "ready":
        this.resolveReadyOnce();
        break;
      case "result": {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          p.resolve(msg.data);
        }
        break;
      }
      case "allResults": {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          p.resolve(msg.data);
        }
        break;
      }
      case "placements": {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          p.resolve(msg.data);
        }
        break;
      }
      case "fatal":
        this.handleFatal(msg.phase, msg.message);
        break;
      case "error": {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          p.reject(new Error(msg.message));
        }
        break;
      }
    }
  };

  private onWorkerError = (event: ErrorEvent): void => {
    this.handleFatal(
      "runtime",
      event.message || "The WFC worker encountered an unhandled error.",
    );
  };

  private onWorkerMessageError = (): void => {
    this.handleFatal(
      "runtime",
      "The WFC worker sent a message that could not be deserialized.",
    );
  };

  private assertActiveWorker(): Worker {
    if (this.terminalError) {
      throw this.terminalError;
    }
    if (this.disposed) {
      const error = new WfcBridgeError("disposed", "The WFC worker has already been disposed.");
      this.terminalError = error;
      throw error;
    }
    if (!this.worker) {
      const error = new WfcBridgeError(
        "fatal",
        "The WFC worker is no longer available.",
        { phase: "runtime" },
      );
      this.terminalError = error;
      throw error;
    }
    return this.worker;
  }

  private handleFatal(phase: WorkerFatalPhase, message: string): void {
    if (this.terminalError) {
      return;
    }

    const error = new WfcBridgeError("fatal", message, { phase });
    this.terminalError = error;
    this.rejectReadyOnce(error);
    this.rejectPending(error);
    this.detachWorker(true);
  }

  private resolveReadyOnce(): void {
    if (this.readySettled) {
      return;
    }
    this.readySettled = true;
    this.resolveReady();
  }

  private rejectReadyOnce(error: Error): void {
    if (this.readySettled) {
      return;
    }
    this.readySettled = true;
    this.rejectReady(error);
  }

  private rejectPending(error: Error): void {
    for (const { reject } of this.pending.values()) {
      reject(error);
    }
    this.pending.clear();
  }

  private detachWorker(terminate: boolean): void {
    if (!this.worker) {
      return;
    }

    this.worker.removeEventListener("message", this.onMessage);
    this.worker.removeEventListener("error", this.onWorkerError);
    this.worker.removeEventListener("messageerror", this.onWorkerMessageError);
    if (terminate) {
      this.worker.terminate();
    }
    this.worker = null;
  }
}

function normalizeGridResult(result: SolveResultData, gridIndex: number): GridResult {
  return {
    gridIndex,
    cells: result.tiles.map(normalizeCellResult),
  };
}

function assertSolveSucceeded(result: SolveResultData, gridIndex: number): SolveResultData {
  if (result.success) {
    return result;
  }

  const pos = gridIndexToPosition(gridIndex);
  throw new Error(
    `WFC solve failed for grid ${gridIndex} at (${pos.q}, ${pos.r}, ${pos.s}) ` +
    `[tries=${result.tries}, backtracks=${result.backtracks}, dropped_count=${result.dropped_count}, local_wfc_attempts=${result.local_wfc_attempts}]`,
  );
}

function normalizeCellResult(tile: SolveResultData["tiles"][number]): CellResult {
  const size = HEX_WIDTH / 2;
  const worldX = size * (Math.sqrt(3) * tile.q + Math.sqrt(3) / 2 * tile.r);
  const worldZ = size * (3 / 2 * tile.r);

  return {
    q: tile.q,
    r: tile.r,
    s: tile.s,
    tileId: tile.tile_id,
    rotation: tile.rotation,
    elevation: tile.level,
    worldX,
    worldY: tile.level * LEVEL_HEIGHT,
    worldZ,
  };
}

function normalizePlacement(item: PlacementData): PlacementItem {
  const { type, meshId, scale } = normalizePlacementKind(item.placement_type, item.tier);
  return {
    type,
    meshId,
    worldX: item.world_x,
    worldY: item.world_y,
    worldZ: item.world_z,
    rotationY: item.rotation,
    scale,
  };
}

function normalizePlacementKind(
  placementType: number,
  tier: number,
): { type: PlacementType; meshId: string; scale: number } {
  switch (placementType) {
    case 0:
      return { type: "tree", meshId: "tree_a", scale: treeScaleForTier(tier) };
    case 1:
      return { type: "tree", meshId: "tree_b", scale: treeScaleForTier(tier) };
    case 2:
      return { type: "building", meshId: "building", scale: 1 };
    case 3:
      return { type: "windmill", meshId: "windmill", scale: 1.15 };
    case 4:
      return { type: "bridge", meshId: "bridge", scale: 1 };
    case 5:
      return { type: "waterlily", meshId: "waterlily", scale: 0.75 };
    case 6:
      return { type: "flower", meshId: "flower", scale: 0.55 };
    case 7:
      return { type: "rock", meshId: "rock", scale: 0.8 };
    case 8:
      return { type: "hill", meshId: "hill", scale: 1.2 };
    case 9:
      return { type: "mountain", meshId: "mountain", scale: 1.5 };
    default:
      throw new Error(`unknown placement type: ${placementType}`);
  }
}

function treeScaleForTier(tier: number): number {
  switch (tier) {
    case 0:
      return 0.85;
    case 1:
      return 1;
    case 2:
      return 1.2;
    default:
      return 1.35;
  }
}
