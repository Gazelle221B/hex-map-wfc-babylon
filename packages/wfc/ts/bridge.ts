import type {
  BuildSummary,
  CellResult,
  CoordResult,
  GridResult,
  PackedGridChunk,
  PackedPlacementChunk,
  PlacementItem,
  WfcEvents,
} from "@hex/types";
import {
  DEFAULT_CONFIG,
  HEX_WIDTH,
  LEVEL_HEIGHT,
  PACKED_COORD_STRIDE,
  PACKED_GRID_STRIDE,
  PACKED_PLACEMENT_STRIDE,
  resolvePlacementRenderSpec,
} from "@hex/types";
import { WfcBridgeError, WfcSeedError } from "./errors.js";
import {
  WFC_PROTOCOL_VERSION,
  type PackedSinglePassResult,
  type PackedSolveResult,
  type WfcMode,
  type WorkerFatalPhase,
  type WorkerRequest,
  type WorkerResponse,
} from "./types.js";
import {
  ALL_GRID_POSITIONS,
  gridIndexToCenter,
  gridIndexToPosition,
  gridPositionToIndex,
} from "./grid-positions.js";

type PendingResolve<T> = {
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
};

type WfcOperationName =
  | "solveGrid"
  | "solveAllProgressively"
  | "solveAllSinglePass"
  | "generatePlacements"
  | "buildAllProgressively"
  | "buildAllSinglePass"
  | "reset";

const INIT_TIMEOUT_MS = 30_000;
const BUILD_RETRY_LIMIT = 1;

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

  async ready(): Promise<void> {
    await this.ensureWorkerReady();
  }

  async solveGrid(
    gridQ: number,
    gridR: number,
    options: { tileTypes?: number[]; mode?: WfcMode } = {},
  ): Promise<GridResult> {
    return this.runExclusive("solveGrid", async () => {
      const mode = options.mode ?? "legacy-compat";
      const gridIndex = gridPositionToIndex(gridQ, gridR);
      const raw = await this.solveGridRaw(
        gridQ,
        gridR,
        this.seedForGrid(gridIndex, this.currentSeed, mode),
        mode,
        options.tileTypes,
      );
      return normalizeGridResult(raw, gridIndex);
    });
  }

  async solveAll(seed: number, mode: WfcMode = "legacy-compat"): Promise<GridResult[]> {
    return this.solveAllProgressively(seed, mode);
  }

  async solveAllProgressively(seed: number, mode: WfcMode = "legacy-compat"): Promise<GridResult[]> {
    return this.runExclusive("solveAllProgressively", async () => {
      this.currentSeed = normalizeSeed(seed);
      this.postResetUnsafe();
      const cache = new Map<number, GridResult>();
      const results: GridResult[] = [];
      for (const [gridIndex, pos] of ALL_GRID_POSITIONS.entries()) {
        const raw = await this.solveGridRaw(
          pos.q,
          pos.r,
          this.seedForGrid(gridIndex, seed, mode),
          mode,
        );
        const normalized = normalizeGridResult(raw, gridIndex);
        const impacted = applyGridMetadata(cache, normalized);
        results.push(cache.get(gridIndex)!);
        for (const grid of impacted) {
          this.emitGridSolved(toPackedGridChunk(grid));
        }
      }
      return [...cache.values()].sort((a, b) => a.gridIndex - b.gridIndex);
    });
  }

  async solveAllSinglePass(seed: number, mode: WfcMode = "legacy-compat"): Promise<GridResult[]> {
    return this.runExclusive("solveAllSinglePass", async () => {
      this.currentSeed = normalizeSeed(seed);
      this.postResetUnsafe();
      const raw = await this.solveAllSinglePassRaw(seed, mode);
      return splitSinglePassResult(raw);
    });
  }

  async generatePlacements(
    grids: readonly GridResult[],
    seed: number,
  ): Promise<PlacementItem[]> {
    return this.runExclusive("generatePlacements", async () => {
      this.currentSeed = normalizeSeed(seed);
      const placements = await Promise.all(
        grids.map(async (grid) => {
          const pos = gridIndexToPosition(grid.gridIndex);
          const raw = await this.generatePlacementsPackedRaw(
            pos.q,
            pos.r,
            this.seedForGrid(grid.gridIndex, seed, "modern-fast"),
            0,
            0,
          );
          return [
            ...unpackPlacementItems(raw),
            ...grid.droppedCells.map((coord) => mountainPlacementForCoord(coord, grid)),
          ];
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

  async buildAllProgressively(seed: number, mode: WfcMode = "legacy-compat"): Promise<BuildSummary> {
    return this.runExclusive("buildAllProgressively", async () => {
      this.currentSeed = normalizeSeed(seed);
      for (let attempt = 0; attempt <= BUILD_RETRY_LIMIT; attempt += 1) {
        try {
          return await this.buildAllProgressivelyOnce(seed, mode);
        } catch (error) {
          if (!this.shouldRetryBuild(error, attempt)) {
            throw error;
          }
          this.emitError({
            message: `Restarting progressive build after worker failure: ${error.message}`,
            recoverable: true,
          });
        }
      }
      throw new Error("unreachable build retry state");
    });
  }

  async buildAllSinglePass(seed: number, mode: WfcMode = "legacy-compat"): Promise<BuildSummary> {
    return this.runExclusive("buildAllSinglePass", async () => {
      this.currentSeed = normalizeSeed(seed);
      return this.buildAllSinglePassOnce(seed, mode);
    });
  }

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

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.failCurrentWorker(this.createDisposedError());
  }

  private seedForGrid(gridIndex: number, baseSeed: number, mode: WfcMode): number {
    const normalizedSeed = normalizeSeed(baseSeed);
    const nextSeed = mode === "legacy-compat" ? normalizedSeed : normalizedSeed + gridIndex;
    if (!Number.isSafeInteger(nextSeed)) {
      throw new WfcSeedError(`Seed ${normalizedSeed} is too large to derive a worker-safe grid seed.`);
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

  private async runExclusive<T>(operationName: WfcOperationName, fn: () => Promise<T>): Promise<T> {
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
    wfcMode: WfcMode,
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
        wfcMode,
      },
      id,
    );
  }

  private async solveAllSinglePassRaw(seed: number, wfcMode: WfcMode): Promise<PackedSinglePassResult> {
    const id = this.genId();
    return this.request<PackedSinglePassResult>(
      { type: "solveAllSinglePass", id, seed, wfcMode },
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
      { type: "placements", id, gridQ, gridR, seed, offsetX, offsetZ },
      id,
    );
  }

  private async request<T>(message: WorkerRequest, id: string): Promise<T> {
    await this.ensureWorkerReady();
    const worker = this.requireWorker("runtime");
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      try {
        worker.postMessage(message);
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
    worker.postMessage({ type: "init", protocolVersion: WFC_PROTOCOL_VERSION });
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
      throw new WfcBridgeError("fatal", "The WFC worker is no longer available.", { phase });
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
    worker.postMessage({ type: "reset" });
  }

  private shouldRetryBuild(error: unknown, attempt: number): error is WfcBridgeError {
    return attempt < BUILD_RETRY_LIMIT && error instanceof WfcBridgeError && error.kind === "fatal";
  }

  private async buildAllProgressivelyOnce(seed: number, mode: WfcMode): Promise<BuildSummary> {
    this.postResetUnsafe();
    const total = ALL_GRID_POSITIONS.length;
    const cache = new Map<number, GridResult>();
    const mountainRows = new Map<number, number[]>();
    let solvedCount = 0;
    let fallbackCount = 0;
    let failedCount = 0;

    for (const [gridIndex, pos] of ALL_GRID_POSITIONS.entries()) {
      const raw = await this.solveGridRaw(
        pos.q,
        pos.r,
        this.seedForGrid(gridIndex, seed, mode),
        mode,
      );
      const normalized = normalizeGridResult(raw, gridIndex);
      const impacted = applyGridMetadata(cache, normalized);
      collectDroppedMountains(mountainRows, cache, normalized);
      const current = cache.get(gridIndex)!;
      switch (current.status) {
        case "solved":
          solvedCount += 1;
          break;
        case "fallback_water":
          fallbackCount += 1;
          this.emitError({
            message:
              `Grid ${gridIndex} fell back to water ` +
              `[tries=${current.stats.tries}, backtracks=${current.stats.backtracks}, dropped_count=${current.stats.droppedCount}, local_wfc_attempts=${current.stats.localWfcAttempts}]`,
            gridIndex,
            recoverable: true,
          });
          break;
        case "failed":
          failedCount += 1;
          this.emitError({
            message:
              `Grid ${gridIndex} failed ` +
              `[tries=${current.stats.tries}, backtracks=${current.stats.backtracks}, dropped_count=${current.stats.droppedCount}, local_wfc_attempts=${current.stats.localWfcAttempts}]`,
            gridIndex,
            recoverable: true,
          });
          break;
      }

      for (const grid of impacted) {
        this.emitGridSolved(toPackedGridChunk(grid));
      }
      this.emitProgress({
        phase: "solving",
        completed: gridIndex + 1,
        total,
        gridIndex,
        fallbackCount,
        failedCount,
      });
    }

    for (const [gridIndex, pos] of ALL_GRID_POSITIONS.entries()) {
      const raw = await this.generatePlacementsPackedRaw(
        pos.q,
        pos.r,
        this.seedForGrid(gridIndex, seed, "modern-fast"),
        0,
        0,
      );
      const merged = mergePlacementBuffers(raw, mountainRows.get(gridIndex));
      this.emitPlacementsGenerated({ gridIndex, items: merged });
      this.emitProgress({
        phase: "placements",
        completed: gridIndex + 1,
        total,
        gridIndex,
        fallbackCount,
        failedCount,
      });
    }

    const summary: BuildSummary = {
      totalGrids: total,
      solvedCount,
      fallbackCount,
      failedCount,
    };
    this.emitAllSolved(summary);
    return summary;
  }

  private async buildAllSinglePassOnce(seed: number, mode: WfcMode): Promise<BuildSummary> {
    this.postResetUnsafe();
    const total = ALL_GRID_POSITIONS.length;
    const raw = await this.solveAllSinglePassRaw(seed, mode);
    const grids = splitSinglePassResult(raw);
    const mountainRows = new Map<number, number[]>();
    let solvedCount = 0;
    let fallbackCount = 0;
    let failedCount = 0;

    grids.forEach((grid, index) => {
      if (grid.status === "solved") {
        solvedCount += 1;
      } else if (grid.status === "fallback_water") {
        fallbackCount += 1;
      } else {
        failedCount += 1;
      }
      collectDroppedMountains(mountainRows, new Map([[grid.gridIndex, grid]]), grid);
      this.emitGridSolved(toPackedGridChunk(grid));
      this.emitProgress({
        phase: "solving",
        completed: index + 1,
        total,
        gridIndex: grid.gridIndex,
        fallbackCount,
        failedCount,
      });
    });

    for (const grid of grids) {
      const pos = gridIndexToPosition(grid.gridIndex);
      const rawPlacements = await this.generatePlacementsPackedRaw(
        pos.q,
        pos.r,
        this.seedForGrid(grid.gridIndex, seed, "modern-fast"),
        0,
        0,
      );
      this.emitPlacementsGenerated({
        gridIndex: grid.gridIndex,
        items: mergePlacementBuffers(rawPlacements, mountainRows.get(grid.gridIndex)),
      });
      this.emitProgress({
        phase: "placements",
        completed: grid.gridIndex + 1,
        total,
        gridIndex: grid.gridIndex,
        fallbackCount,
        failedCount,
      });
    }

    const summary: BuildSummary = {
      totalGrids: total,
      solvedCount,
      fallbackCount,
      failedCount,
    };
    this.emitAllSolved(summary);
    return summary;
  }

  private onMessage = (event: MessageEvent<WorkerResponse>): void => {
    const message = event.data;
    switch (message.type) {
      case "ready":
        this.clearInitWatchdog();
        this.resolveReadyOnce();
        break;
      case "result":
      case "singlePassResult":
      case "placements": {
        const pending = this.pending.get(message.id);
        if (pending) {
          this.pending.delete(message.id);
          pending.resolve(message.data);
        }
        break;
      }
      case "fatal":
        this.handleFatal(message.phase, message.message);
        break;
      case "error": {
        const pending = this.pending.get(message.id);
        if (pending) {
          this.pending.delete(message.id);
          pending.reject(new WfcBridgeError("request", message.message));
        }
        break;
      }
    }
  };

  private onWorkerError = (event: ErrorEvent): void => {
    this.handleFatal("runtime", event.message || "The WFC worker encountered an unhandled error.");
  };

  private onWorkerMessageError = (): void => {
    this.handleFatal("runtime", "The WFC worker produced an unreadable message.");
  };

  private handleFatal(phase: WorkerFatalPhase, message: string): void {
    this.failCurrentWorker(new WfcBridgeError("fatal", message, { phase }));
  }

  private detachWorker(terminate: boolean): void {
    const worker = this.worker;
    if (!worker) {
      return;
    }
    this.worker = null;
    worker.removeEventListener("message", this.onMessage);
    worker.removeEventListener("error", this.onWorkerError);
    worker.removeEventListener("messageerror", this.onWorkerMessageError);
    if (terminate) {
      worker.terminate();
    }
  }

  private rejectReadyOnce(reason: Error): void {
    if (this.readySettled) {
      return;
    }
    this.readySettled = true;
    this.rejectReady(reason);
  }

  private resolveReadyOnce(): void {
    if (this.readySettled) {
      return;
    }
    this.readySettled = true;
    this.resolveReady();
  }

  private rejectPending(reason: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(reason);
    }
    this.pending.clear();
  }

  private emitGridSolved(chunk: PackedGridChunk): void {
    for (const subscriber of this.subscriptions) {
      subscriber.onGridSolved?.(chunk);
    }
  }

  private emitPlacementsGenerated(chunk: PackedPlacementChunk): void {
    for (const subscriber of this.subscriptions) {
      subscriber.onPlacementsGenerated?.(chunk);
    }
  }

  private emitProgress(progress: Parameters<NonNullable<WfcEvents["onProgress"]>>[0]): void {
    for (const subscriber of this.subscriptions) {
      subscriber.onProgress?.(progress);
    }
  }

  private emitError(error: Parameters<NonNullable<WfcEvents["onError"]>>[0]): void {
    for (const subscriber of this.subscriptions) {
      subscriber.onError?.(error);
    }
  }

  private emitAllSolved(summary: BuildSummary): void {
    for (const subscriber of this.subscriptions) {
      subscriber.onAllSolved?.(summary);
    }
  }
}

function normalizeGridResult(result: PackedSolveResult, gridIndex: number): GridResult {
  return {
    gridIndex,
    status: result.status,
    cells: unpackGridCells(result.cells),
    collapseOrder: unpackGridCells(result.collapse_order),
    changedFixedCells: unpackGridCells(result.changed_fixed_cells),
    unfixedCells: unpackCoords(result.unfixed_cells),
    droppedCells: unpackCoords(result.dropped_cells),
    lastConflict: result.last_conflict,
    neighborConflict: result.neighbor_conflict,
    stats: {
      backtracks: result.backtracks,
      tries: result.tries,
      localWfcAttempts: result.local_wfc_attempts,
      droppedCount: result.dropped_count,
    },
  };
}

function splitSinglePassResult(result: PackedSinglePassResult): GridResult[] {
  const groupedCells = new Map<number, CellResult[]>();
  const groupedCollapseOrder = new Map<number, CellResult[]>();
  unpackGridCells(result.cells).forEach((cell) => {
    for (const gridIndex of gridIndicesForCellCoord(cell.q, cell.r)) {
      const bucket = groupedCells.get(gridIndex) ?? [];
      bucket.push(cell);
      groupedCells.set(gridIndex, bucket);
    }
  });
  unpackGridCells(result.collapse_order).forEach((cell) => {
    for (const gridIndex of gridIndicesForCellCoord(cell.q, cell.r)) {
      const bucket = groupedCollapseOrder.get(gridIndex) ?? [];
      bucket.push(cell);
      groupedCollapseOrder.set(gridIndex, bucket);
    }
  });

  return ALL_GRID_POSITIONS.map((_, gridIndex) => ({
    gridIndex,
    status: groupedCells.has(gridIndex) ? result.status : (result.status === "failed" ? "failed" : "solved"),
    cells: groupedCells.get(gridIndex) ?? [],
    collapseOrder: groupedCollapseOrder.get(gridIndex) ?? [],
    changedFixedCells: [],
    unfixedCells: [],
    droppedCells: [],
    lastConflict: result.last_conflict,
    neighborConflict: result.neighbor_conflict,
    stats: {
      backtracks: result.backtracks,
      tries: result.tries,
      localWfcAttempts: 0,
      droppedCount: 0,
    },
  }));
}

function applyGridMetadata(cache: Map<number, GridResult>, next: GridResult): GridResult[] {
  const currentGrid: GridResult = {
    ...next,
    cells: next.cells.filter((cell) => !next.unfixedCells.some((coord) => sameCoord(coord, cell))),
  };
  cache.set(currentGrid.gridIndex, currentGrid);
  const impacted = new Map<number, GridResult>([[currentGrid.gridIndex, currentGrid]]);

  for (const changedCell of next.changedFixedCells) {
    const sourceGridIndex = gridIndexForCellCoord(changedCell.q, changedCell.r);
    if (sourceGridIndex === null) {
      continue;
    }
    const existing = cache.get(sourceGridIndex);
    if (!existing) {
      continue;
    }
    const patchedCells = existing.cells.map((cell) =>
      sameCoord(cell, changedCell)
        ? {
            ...cell,
            tileId: changedCell.tileId,
            rotation: changedCell.rotation,
            elevation: changedCell.elevation,
            worldY: changedCell.worldY,
          }
        : cell,
    );
    const patched = { ...existing, cells: patchedCells };
    cache.set(sourceGridIndex, patched);
    impacted.set(sourceGridIndex, patched);
  }

  return [...impacted.values()].sort((left, right) => left.gridIndex - right.gridIndex);
}

function collectDroppedMountains(
  mountainRows: Map<number, number[]>,
  cache: Map<number, GridResult>,
  grid: GridResult,
): void {
  grid.droppedCells.forEach((coord) => {
    const sourceGridIndex = gridIndexForCellCoord(coord.q, coord.r);
    if (sourceGridIndex === null) {
      return;
    }
    const sourceGrid = cache.get(sourceGridIndex);
    if (!sourceGrid) {
      return;
    }
    const sourceCell = sourceGrid.cells.find((cell) => sameCoord(cell, coord));
    if (!sourceCell) {
      return;
    }
    const bucket = mountainRows.get(sourceGridIndex) ?? [];
    bucket.push(9, 0, sourceCell.worldX, sourceCell.worldY + LEVEL_HEIGHT, sourceCell.worldZ, 0);
    mountainRows.set(sourceGridIndex, bucket);
  });
}

function toPackedGridChunk(grid: GridResult): PackedGridChunk {
  return {
    gridIndex: grid.gridIndex,
    status: grid.status,
    cells: packGridCells(grid.cells),
    collapseOrder: packGridCells(grid.collapseOrder),
    changedFixedCells: packGridCells(grid.changedFixedCells),
    unfixedCells: packCoords(grid.unfixedCells),
    droppedCells: packCoords(grid.droppedCells),
    lastConflict: grid.lastConflict,
    neighborConflict: grid.neighborConflict,
    stats: grid.stats,
  };
}

function packGridCells(cells: readonly CellResult[]): Int32Array {
  const packed = new Int32Array(cells.length * PACKED_GRID_STRIDE);
  cells.forEach((cell, index) => {
    const offset = index * PACKED_GRID_STRIDE;
    packed[offset] = cell.q;
    packed[offset + 1] = cell.r;
    packed[offset + 2] = cell.tileId;
    packed[offset + 3] = cell.rotation;
    packed[offset + 4] = cell.elevation;
  });
  return packed;
}

function packCoords(coords: readonly CoordResult[]): Int32Array {
  const packed = new Int32Array(coords.length * PACKED_COORD_STRIDE);
  coords.forEach((coord, index) => {
    const offset = index * PACKED_COORD_STRIDE;
    packed[offset] = coord.q;
    packed[offset + 1] = coord.r;
    packed[offset + 2] = coord.s;
  });
  return packed;
}

function mergePlacementBuffers(base: Float32Array, extras?: readonly number[]): Float32Array {
  if (!extras || extras.length === 0) {
    return base;
  }
  const merged = new Float32Array(base.length + extras.length);
  merged.set(base, 0);
  merged.set(extras, base.length);
  return merged;
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
    const elevation = cells[index + 4];
    result.push({
      q,
      r,
      s: -q - r,
      tileId,
      rotation,
      elevation,
      worldX: sizeTimesSqrt3 * q + sizeTimesSqrt3Over2 * r,
      worldY: elevation * LEVEL_HEIGHT,
      worldZ: sizeTimesThreeOver2 * r,
    });
  }

  return result;
}

function unpackCoords(coords: Int32Array): CoordResult[] {
  const result: CoordResult[] = [];
  for (let index = 0; index < coords.length; index += PACKED_COORD_STRIDE) {
    result.push({
      q: coords[index],
      r: coords[index + 1],
      s: coords[index + 2],
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

function mountainPlacementForCoord(coord: CoordResult, grid: GridResult): PlacementItem {
  const source = grid.cells.find((cell) => sameCoord(cell, coord));
  const spec = resolvePlacementRenderSpec(9, 0);
  return {
    type: spec.type,
    meshId: spec.meshId,
    worldX: source?.worldX ?? cubeToWorldX(coord.q, coord.r),
    worldY: (source?.worldY ?? 0) + LEVEL_HEIGHT,
    worldZ: source?.worldZ ?? cubeToWorldZ(coord.r),
    rotationY: 0,
    scale: spec.scale,
  };
}

function sameCoord(left: CoordResult, right: CoordResult): boolean {
  return left.q === right.q && left.r === right.r && left.s === right.s;
}

function gridIndexForCellCoord(q: number, r: number): number | null {
  return gridIndicesForCellCoord(q, r)[0] ?? null;
}

function gridIndicesForCellCoord(q: number, r: number): number[] {
  const s = -q - r;
  const matches: number[] = [];
  for (const [index] of ALL_GRID_POSITIONS.entries()) {
    const center = gridIndexToCenter(index);
    const centerQ = center.q;
    const centerR = center.r;
    const centerS = center.s;
    const distance = (Math.abs(q - centerQ) + Math.abs(r - centerR) + Math.abs(s - centerS)) / 2;
    if (distance <= DEFAULT_CONFIG.gridRadius) {
      matches.push(index);
    }
  }
  return matches;
}

function cubeToWorldX(q: number, r: number): number {
  const size = HEX_WIDTH / 2;
  return size * (Math.sqrt(3) * q + (Math.sqrt(3) / 2) * r);
}

function cubeToWorldZ(r: number): number {
  return (HEX_WIDTH / 2) * (3 / 2) * r;
}

function normalizeSeed(seed: number): number {
  if (!Number.isFinite(seed) || !Number.isInteger(seed) || seed < 0 || !Number.isSafeInteger(seed)) {
    throw new WfcSeedError(`Seed must be a finite, non-negative safe integer. Received: ${seed}.`);
  }
  return seed;
}
