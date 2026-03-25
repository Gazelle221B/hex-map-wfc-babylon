import type { CellResult, GridResult, PlacementItem, PlacementType } from "@hex/types";
import { HEX_WIDTH, LEVEL_HEIGHT } from "@hex/types";
import type {
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
  private worker: Worker;
  private pending = new Map<string, PendingResolve<unknown>>();
  private readyPromise: Promise<void>;
  private nextId = 0;

  constructor(seed: number) {
    this.worker = new Worker(
      new URL("./worker.ts", import.meta.url),
      { type: "module" },
    );

    this.readyPromise = new Promise<void>((resolve) => {
      const onReady = (event: MessageEvent<WorkerResponse>) => {
        if (event.data.type === "ready") {
          this.worker.removeEventListener("message", onReady);
          resolve();
        }
      };
      this.worker.addEventListener("message", onReady);
    });

    this.worker.addEventListener("message", this.onMessage);
    this.send({ type: "init", seed });
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
    return normalizeGridResult(raw, gridIndex);
  }

  /** Solve all 19 grids. */
  async solveAll(seed: number): Promise<GridResult[]> {
    const rawResults = await this.solveAllRaw(seed);
    return rawResults.map((result, gridIndex) => normalizeGridResult(result, gridIndex));
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
    this.send({ type: "reset" });
  }

  /** Terminate the worker. */
  dispose(): void {
    this.worker.removeEventListener("message", this.onMessage);
    this.worker.terminate();
    for (const { reject } of this.pending.values()) {
      reject(new Error("worker terminated"));
    }
    this.pending.clear();
  }

  private send(msg: WorkerRequest): void {
    this.worker.postMessage(msg);
  }

  private request<T>(msg: WorkerRequest, id: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.send(msg);
    });
  }

  private genId(): string {
    return String(++this.nextId);
  }

  private onMessage = (event: MessageEvent<WorkerResponse>): void => {
    const msg = event.data;

    switch (msg.type) {
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
}

function normalizeGridResult(result: SolveResultData, gridIndex: number): GridResult {
  return {
    gridIndex,
    cells: result.tiles.map(normalizeCellResult),
  };
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
