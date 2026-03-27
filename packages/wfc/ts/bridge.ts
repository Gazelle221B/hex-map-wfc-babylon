import type {
  BuildSummary,
  CellResult,
  GridResult,
  PackedGridChunk,
  PackedPlacementChunk,
  PlacementItem,
  WfcEvents,
} from "@hex/types";
import {
  HEX_WIDTH,
  LEVEL_HEIGHT,
  resolvePlacementRenderSpec,
} from "@hex/types";
import { WfcBridgeError } from "./errors.js";
import type {
  PackedSolveResult,
  WorkerFatalPhase,
  WorkerRequest,
  WorkerResponse,
} from "./types.js";
import { ALL_GRID_POSITIONS, gridIndexToPosition, gridPositionToIndex } from "./grid-positions.js";

type PendingResolve<T> = {
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
};

type WfcOperationName =
  | "solveGrid"
  | "solveAll"
  | "generatePlacements"
  | "buildAllProgressively"
  | "reset";

/**
 * Bridge between the main thread and the WFC WASM worker.
 * Provides a Promise-based API for grid solving and placement generation.
 */
export class WfcBridge {
  private worker: Worker | null;
  private pending = new Map<string, PendingResolve<unknown>>();
  private subscriptions = new Set<Partial<WfcEvents>>();
  private readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (reason: Error) => void;
  private readySettled = false;
  private disposed = false;
  private terminalError: Error | null = null;
  private nextId = 0;
  private activeOperation: WfcOperationName | null = null;
  private currentSeed: number;

  constructor(seed: number) {
    this.currentSeed = seed;
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
    this.post({ type: "init" }, "init");
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
    return this.runExclusive("solveGrid", async () => {
      const gridIndex = gridPositionToIndex(gridQ, gridR);
      const raw = await this.solveGridRaw(
        gridQ,
        gridR,
        this.seedForGrid(gridIndex),
        tileTypes,
      );
      return normalizeGridResult(raw, gridIndex);
    });
  }

  /** Solve all 19 grids. */
  async solveAll(seed: number): Promise<GridResult[]> {
    return this.runExclusive("solveAll", async () => {
      this.currentSeed = seed;
      this.postResetUnsafe();
      const results: GridResult[] = [];
      for (const [gridIndex, pos] of ALL_GRID_POSITIONS.entries()) {
        const raw = await this.solveGridRaw(pos.q, pos.r, this.seedForGrid(gridIndex, seed));
        results.push(normalizeGridResult(raw, gridIndex));
      }
      return results;
    });
  }

  /** Generate placements for a solved set of grids. */
  async generatePlacements(
    grids: readonly GridResult[],
    seed: number,
  ): Promise<PlacementItem[]> {
    return this.runExclusive("generatePlacements", async () => {
      this.currentSeed = seed;
      const placements = await Promise.all(
        grids.map(async (grid) => {
          const pos = gridIndexToPosition(grid.gridIndex);
          const raw = await this.generatePlacementsPackedRaw(
            pos.q,
            pos.r,
            this.seedForGrid(grid.gridIndex, seed),
            0,
            0,
          );
          return unpackPlacementItems(raw);
        }),
      );
      return placements.flat();
    });
  }

  subscribe(events: Partial<WfcEvents>): () => void {
    this.subscriptions.add(events);
    return () => {
      this.subscriptions.delete(events);
    };
  }

  async buildAllProgressively(seed: number): Promise<BuildSummary> {
    return this.runExclusive("buildAllProgressively", async () => {
      this.currentSeed = seed;
      const total = ALL_GRID_POSITIONS.length;
      let solvedCount = 0;
      let fallbackCount = 0;

      this.postResetUnsafe();

      for (const [gridIndex, pos] of ALL_GRID_POSITIONS.entries()) {
        const raw = await this.solveGridRaw(
          pos.q,
          pos.r,
          this.seedForGrid(gridIndex, seed),
        );
        const chunk: PackedGridChunk = {
          gridIndex,
          status: raw.status,
          cells: raw.cells,
        };

        if (raw.status === "fallback_water") {
          fallbackCount += 1;
          this.emitError({
            message:
              `Grid ${gridIndex} fell back to water ` +
              `[tries=${raw.tries}, backtracks=${raw.backtracks}, dropped_count=${raw.dropped_count}, local_wfc_attempts=${raw.local_wfc_attempts}]`,
            gridIndex,
            recoverable: true,
          });
        } else {
          solvedCount += 1;
        }

        this.emitGridSolved(chunk);
        this.emitProgress({
          phase: "solving",
          completed: gridIndex + 1,
          total,
          gridIndex,
          fallbackCount,
        });
      }

      for (const [gridIndex, pos] of ALL_GRID_POSITIONS.entries()) {
        const items = await this.generatePlacementsPackedRaw(
          pos.q,
          pos.r,
          this.seedForGrid(gridIndex, seed),
          0,
          0,
        );
        this.emitPlacementsGenerated({ gridIndex, items });
        this.emitProgress({
          phase: "placements",
          completed: gridIndex + 1,
          total,
          gridIndex,
          fallbackCount,
        });
      }

      const summary: BuildSummary = {
        totalGrids: total,
        solvedCount,
        fallbackCount,
      };
      this.emitAllSolved(summary);
      return summary;
    });
  }

  private seedForGrid(gridIndex: number, baseSeed = this.currentSeed): number {
    return baseSeed + gridIndex;
  }

  private assertIdle(operationName: WfcOperationName): void {
    this.assertActiveWorker();
    if (this.activeOperation) {
      throw new WfcBridgeError(
        "busy",
        `Cannot start ${operationName} while ${this.activeOperation} is in progress.`,
      );
    }
  }

  private async runExclusive<T>(
    operationName: WfcOperationName,
    fn: () => Promise<T>,
  ): Promise<T> {
    this.assertIdle(operationName);
    this.activeOperation = operationName;

    try {
      return await fn();
    } finally {
      this.activeOperation = null;
    }
  }

  private async solveGridRaw(
    gridQ: number,
    gridR: number,
    seed: number,
    tileTypes?: number[],
  ): Promise<PackedSolveResult> {
    const id = this.genId();
    return this.request<PackedSolveResult>({
      type: "solve",
      id,
      gridQ,
      gridR,
      seed,
      tileTypes,
    }, id);
  }

  private async generatePlacementsPackedRaw(
    gridQ: number,
    gridR: number,
    seed: number,
    offsetX: number,
    offsetZ: number,
  ): Promise<Float32Array> {
    const id = this.genId();
    return this.request<Float32Array>({
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
    this.assertIdle("reset");
    this.postResetUnsafe();
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

  private postResetUnsafe(): void {
    this.post({ type: "reset" }, "runtime");
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

  private emitGridSolved(chunk: PackedGridChunk): void {
    for (const events of this.subscriptions) {
      events.onGridSolved?.(chunk);
    }
  }

  private emitPlacementsGenerated(chunk: PackedPlacementChunk): void {
    for (const events of this.subscriptions) {
      events.onPlacementsGenerated?.(chunk);
    }
  }

  private emitProgress(progress: Parameters<NonNullable<WfcEvents["onProgress"]>>[0]): void {
    for (const events of this.subscriptions) {
      events.onProgress?.(progress);
    }
  }

  private emitError(error: Parameters<NonNullable<WfcEvents["onError"]>>[0]): void {
    for (const events of this.subscriptions) {
      events.onError?.(error);
    }
  }

  private emitAllSolved(summary: BuildSummary): void {
    for (const events of this.subscriptions) {
      events.onAllSolved?.(summary);
    }
  }
}

function normalizeGridResult(result: PackedSolveResult, gridIndex: number): GridResult {
  return {
    gridIndex,
    cells: unpackGridCells(result.cells),
  };
}

function unpackGridCells(cells: Int32Array): CellResult[] {
  const stride = 5;
  const result: CellResult[] = [];
  const size = HEX_WIDTH / 2;

  for (let index = 0; index < cells.length; index += stride) {
    const q = cells[index];
    const r = cells[index + 1];
    const tileId = cells[index + 2];
    const rotation = cells[index + 3];
    const level = cells[index + 4];
    const worldX = size * (Math.sqrt(3) * q + Math.sqrt(3) / 2 * r);
    const worldZ = size * (3 / 2 * r);

    result.push({
      q,
      r,
      s: -q - r,
      tileId,
      rotation,
      elevation: level,
      worldX,
      worldY: level * LEVEL_HEIGHT,
      worldZ,
    });
  }

  return result;
}

function unpackPlacementItems(items: Float32Array): PlacementItem[] {
  const stride = 6;
  const result: PlacementItem[] = [];

  for (let index = 0; index < items.length; index += stride) {
    const placementType = Math.round(items[index]);
    const tier = Math.round(items[index + 1]);
    const spec = resolvePlacementRenderSpec(placementType, tier);
    result.push({
      type: spec.type,
      meshId: spec.meshId,
      worldX: items[index + 2],
      worldY: items[index + 3],
      worldZ: items[index + 4],
      rotationY: items[index + 5],
      scale: spec.scale,
    });
  }

  return result;
}
