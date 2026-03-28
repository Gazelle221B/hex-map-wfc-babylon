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
  PACKED_GRID_STRIDE,
  PACKED_PLACEMENT_STRIDE,
  resolvePlacementRenderSpec,
} from "@hex/types";
import { WfcBridgeError } from "./errors.js";
import {
  WFC_PROTOCOL_VERSION,
  type PackedSolveResult,
  type WorkerFatalPhase,
  type WorkerRequest,
  type WorkerResponse,
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

const INIT_TIMEOUT_MS = 30_000;
const BUILD_RETRY_LIMIT = 1;
const RESTART_PROGRESS_GRID_INDEX = 0;

/**
 * Bridge between the main thread and the WFC WASM worker.
 * Provides a Promise-based API for grid solving and placement generation.
 */
export class WfcBridge {
  private worker: Worker | null = null;
  private pending = new Map<string, PendingResolve<unknown>>();
  private subscriptions = new Set<Partial<WfcEvents>>();
  private readyPromise!: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (reason: Error) => void;
  private readySettled = false;
  private disposed = false;
  private nextId = 0;
  private activeOperation: WfcOperationName | null = null;
  private currentSeed: number;
  private initWatchdog: ReturnType<typeof setTimeout> | null = null;

  constructor(seed: number) {
    this.currentSeed = normalizeSeed(seed);
    this.spawnWorker();
  }

  /** Wait for the current worker generation to initialize. */
  async ready(): Promise<void> {
    await this.ensureWorkerReady();
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
      this.currentSeed = normalizeSeed(seed);
      this.postResetUnsafe();
      const results: GridResult[] = [];
      for (const [gridIndex, pos] of ALL_GRID_POSITIONS.entries()) {
        this.assertNotDisposed();
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
      this.currentSeed = normalizeSeed(seed);
      const placements = await Promise.all(
        grids.map(async (grid) => {
          this.assertNotDisposed();
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
      this.currentSeed = normalizeSeed(seed);

      for (let attempt = 0; attempt <= BUILD_RETRY_LIMIT; attempt += 1) {
        this.assertNotDisposed();

        try {
          return await this.buildAllProgressivelyOnce(seed);
        } catch (error) {
          if (!this.shouldRetryProgressiveBuild(error, attempt)) {
            throw error;
          }

          this.emitError({
            message: `Restarting progressive build after worker failure: ${error.message}`,
            recoverable: true,
          });
          this.emitProgress({
            phase: "solving",
            completed: 0,
            total: ALL_GRID_POSITIONS.length,
            gridIndex: RESTART_PROGRESS_GRID_INDEX,
            fallbackCount: 0,
          });
          await this.recreateWorker();
        }
      }

      throw new Error("unreachable progressive build retry state");
    });
  }

  /** Reset the engine state. */
  reset(): void {
    if (this.disposed) {
      return;
    }
    this.assertIdle("reset");
    if (!this.worker) {
      this.spawnWorker();
    }
    this.postResetUnsafe();
  }

  /** Terminate the worker. */
  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.failCurrentWorker(this.createDisposedError());
  }

  private seedForGrid(gridIndex: number, baseSeed = this.currentSeed): number {
    const normalizedSeed = normalizeSeed(baseSeed);
    const nextSeed = normalizedSeed + gridIndex;
    if (!Number.isSafeInteger(nextSeed)) {
      throw new RangeError(
        `Seed ${normalizedSeed} is too large to derive a worker-safe grid seed.`,
      );
    }
    return nextSeed;
  }

  private assertIdle(operationName: WfcOperationName): void {
    this.assertNotDisposed();
    if (this.activeOperation) {
      throw new WfcBridgeError(
        "busy",
        `Cannot start ${operationName} while ${this.activeOperation} is in progress.`,
      );
    }
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw this.createDisposedError();
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
    return this.request<PackedSolveResult>(
      {
        type: "solve",
        id,
        gridQ,
        gridR,
        seed,
        tileTypes,
      },
      id,
    );
  }

  private async generatePlacementsPackedRaw(
    gridQ: number,
    gridR: number,
    seed: number,
    offsetX: number,
    offsetZ: number,
  ): Promise<Float32Array> {
    const id = this.genId();
    return this.request<Float32Array>(
      {
        type: "placements",
        id,
        gridQ,
        gridR,
        seed,
        offsetX,
        offsetZ,
      },
      id,
    );
  }

  private async request<T>(msg: WorkerRequest, id: string): Promise<T> {
    await this.ensureWorkerReady();
    const worker = this.requireWorker("runtime");

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      try {
        worker.postMessage(msg);
      } catch (error) {
        this.pending.delete(id);
        const details = error instanceof Error ? error.message : String(error);
        const bridgeError = new WfcBridgeError(
          "fatal",
          `Failed to post a message to the WFC worker: ${details}`,
          { phase: "runtime" },
        );
        this.failCurrentWorker(bridgeError);
        reject(bridgeError);
      }
    });
  }

  private genId(): string {
    return String(++this.nextId);
  }

  private resetReadyPromise(): void {
    this.readySettled = false;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
  }

  private spawnWorker(): void {
    this.assertNotDisposed();
    if (this.worker) {
      return;
    }

    this.resetReadyPromise();
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    this.worker = worker;
    worker.addEventListener("message", this.onMessage);
    worker.addEventListener("error", this.onWorkerError);
    worker.addEventListener("messageerror", this.onWorkerMessageError);
    this.startInitWatchdog(worker);

    try {
      worker.postMessage({ type: "init", protocolVersion: WFC_PROTOCOL_VERSION });
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      const bridgeError = new WfcBridgeError(
        "fatal",
        `Failed to post a message to the WFC worker: ${details}`,
        { phase: "init" },
      );
      this.failCurrentWorker(bridgeError);
      throw bridgeError;
    }
  }

  private async recreateWorker(): Promise<void> {
    this.assertNotDisposed();
    if (this.worker) {
      this.failCurrentWorker(
        new WfcBridgeError("fatal", "Restarting the WFC worker.", { phase: "runtime" }),
      );
    }
    this.spawnWorker();
    await this.readyPromise;
  }

  private startInitWatchdog(worker: Worker): void {
    this.clearInitWatchdog();
    this.initWatchdog = setTimeout(() => {
      if (this.disposed || this.worker !== worker || this.readySettled) {
        return;
      }

      this.failCurrentWorker(
        new WfcBridgeError(
          "fatal",
          `Timed out while initializing the WFC worker after ${INIT_TIMEOUT_MS}ms.`,
          { phase: "init" },
        ),
      );
    }, INIT_TIMEOUT_MS);
  }

  private clearInitWatchdog(): void {
    if (this.initWatchdog === null) {
      return;
    }

    clearTimeout(this.initWatchdog);
    this.initWatchdog = null;
  }

  private failCurrentWorker(error: Error): void {
    this.clearInitWatchdog();
    this.detachWorker(true);
    this.rejectReadyOnce(error);
    this.rejectPending(error);
  }

  private async ensureWorkerReady(): Promise<void> {
    this.assertNotDisposed();
    if (!this.worker) {
      this.spawnWorker();
    }
    await this.readyPromise;
  }

  private requireWorker(phase: WorkerFatalPhase): Worker {
    this.assertNotDisposed();
    if (!this.worker) {
      throw new WfcBridgeError(
        "fatal",
        "The WFC worker is no longer available.",
        { phase },
      );
    }
    return this.worker;
  }

  private createDisposedError(): WfcBridgeError {
    return new WfcBridgeError("disposed", "The WFC worker was disposed.");
  }

  private postResetUnsafe(): void {
    const worker = this.worker;
    if (!worker) {
      return;
    }

    try {
      worker.postMessage({ type: "reset" });
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      this.failCurrentWorker(
        new WfcBridgeError(
          "fatal",
          `Failed to post a message to the WFC worker: ${details}`,
          { phase: "runtime" },
        ),
      );
    }
  }

  private shouldRetryProgressiveBuild(error: unknown, attempt: number): error is WfcBridgeError {
    if (attempt >= BUILD_RETRY_LIMIT || this.disposed) {
      return false;
    }

    return error instanceof WfcBridgeError && error.kind === "fatal";
  }

  private async buildAllProgressivelyOnce(seed: number): Promise<BuildSummary> {
    const total = ALL_GRID_POSITIONS.length;
    let solvedCount = 0;
    let fallbackCount = 0;

    this.postResetUnsafe();

    for (const [gridIndex, pos] of ALL_GRID_POSITIONS.entries()) {
      this.assertNotDisposed();
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
      this.assertNotDisposed();
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
  }

  private onMessage = (event: MessageEvent<WorkerResponse>): void => {
    const msg = event.data;

    switch (msg.type) {
      case "ready":
        this.clearInitWatchdog();
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

  private handleFatal(phase: WorkerFatalPhase, message: string): void {
    if (this.disposed) {
      return;
    }

    this.failCurrentWorker(new WfcBridgeError("fatal", message, { phase }));
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
    this.clearInitWatchdog();
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
  const result: CellResult[] = [];
  const size = HEX_WIDTH / 2;
  const sqrt3 = Math.sqrt(3);
  const sizeTimesSqrt3 = size * sqrt3;
  const sizeTimesSqrt3Over2 = size * (sqrt3 / 2);
  const sizeTimesThreeOver2 = size * (3 / 2);

  for (let index = 0; index < cells.length; index += PACKED_GRID_STRIDE) {
    const q = cells[index];
    const r = cells[index + 1];
    const tileId = cells[index + 2];
    const rotation = cells[index + 3];
    const level = cells[index + 4];
    const worldX = sizeTimesSqrt3 * q + sizeTimesSqrt3Over2 * r;
    const worldZ = sizeTimesThreeOver2 * r;

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
  const result: PlacementItem[] = [];

  for (let index = 0; index < items.length; index += PACKED_PLACEMENT_STRIDE) {
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

function normalizeSeed(seed: number): number {
  if (!Number.isFinite(seed) || !Number.isInteger(seed) || seed < 0 || !Number.isSafeInteger(seed)) {
    throw new RangeError(
      `Seed must be a finite, non-negative safe integer. Received: ${seed}.`,
    );
  }

  return seed;
}
