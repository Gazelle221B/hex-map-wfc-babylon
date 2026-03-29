import { Matrix, Quaternion, Vector3 } from "@babylonjs/core";
import {
  HEX_WIDTH,
  LEVEL_HEIGHT,
  PACKED_GRID_STRIDE,
  TILE_LIST,
  type GridResult,
  type PackedGridChunk,
} from "@hex/types";
import type { TilePool } from "./tile-pool.js";

export class GridMeshLayer {
  private readonly contributions = new Map<number, Map<string, Float32Array>>();
  private readonly meshContributions = new Map<string, Map<number, Float32Array>>();
  private readonly dirtyMeshIds = new Set<string>();
  private readonly activeMeshIds = new Set<string>();
  private syncScheduled = false;
  private disposed = false;

  constructor(private readonly tilePool: TilePool) {}

  addGrid(result: GridResult): void {
    const cells = new Int32Array(result.cells.length * PACKED_GRID_STRIDE);
    result.cells.forEach((cell, index) => {
      const offset = index * PACKED_GRID_STRIDE;
      cells[offset] = cell.q;
      cells[offset + 1] = cell.r;
      cells[offset + 2] = cell.tileId;
      cells[offset + 3] = cell.rotation;
      cells[offset + 4] = cell.elevation;
    });
    this.addPackedGrid({
      gridIndex: result.gridIndex,
      status: result.status,
      cells,
      collapseOrder: new Int32Array(0),
      changedFixedCells: new Int32Array(0),
      unfixedCells: new Int32Array(0),
      droppedCells: new Int32Array(0),
      lastConflict: null,
      neighborConflict: null,
      stats: result.stats,
    });
  }

  addPackedGrid(chunk: PackedGridChunk): void {
    if (this.disposed) {
      return;
    }
    this.replaceContribution(chunk.gridIndex, buildGridContribution(chunk.cells));
    this.scheduleSync();
  }

  clear(): void {
    if (this.disposed) {
      return;
    }
    for (const meshId of this.activeMeshIds) {
      this.dirtyMeshIds.add(meshId);
    }
    this.contributions.clear();
    this.meshContributions.clear();
    this.flushSync();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.syncScheduled = false;
    this.contributions.clear();
    this.meshContributions.clear();
    this.dirtyMeshIds.clear();
    this.activeMeshIds.clear();
  }

  private replaceContribution(gridIndex: number, nextContribution: Map<string, Float32Array>): void {
    const previousContribution = this.contributions.get(gridIndex);
    this.contributions.set(gridIndex, nextContribution);

    const affectedMeshIds = new Set<string>();
    for (const meshId of previousContribution?.keys() ?? []) {
      affectedMeshIds.add(meshId);
    }
    for (const meshId of nextContribution.keys()) {
      affectedMeshIds.add(meshId);
    }

    for (const meshId of affectedMeshIds) {
      const partsByGrid = this.meshContributions.get(meshId) ?? new Map<number, Float32Array>();
      const nextMatrices = nextContribution.get(meshId);

      if (nextMatrices) {
        partsByGrid.set(gridIndex, nextMatrices);
        this.meshContributions.set(meshId, partsByGrid);
      } else {
        partsByGrid.delete(gridIndex);
        if (partsByGrid.size === 0) {
          this.meshContributions.delete(meshId);
        } else {
          this.meshContributions.set(meshId, partsByGrid);
        }
      }

      this.dirtyMeshIds.add(meshId);
    }
  }

  private scheduleSync(): void {
    if (this.syncScheduled || this.disposed) {
      return;
    }
    this.syncScheduled = true;
    queueMicrotask(() => {
      this.syncScheduled = false;
      this.flushSync();
    });
  }

  private flushSync(): void {
    if (this.disposed) {
      return;
    }

    const dirtyMeshIds = [...this.dirtyMeshIds];
    this.dirtyMeshIds.clear();

    for (const meshId of dirtyMeshIds) {
      const source = this.tilePool.getTemplate(meshId);
      const parts = this.meshContributions.get(meshId);

      if (!parts || parts.size === 0) {
        source.thinInstanceSetBuffer("matrix", new Float32Array(0), 16, true);
        this.activeMeshIds.delete(meshId);
        continue;
      }

      const matricesByGrid = [...parts.values()];
      const totalLength = matricesByGrid.reduce((sum, item) => sum + item.length, 0);
      const matrices = new Float32Array(totalLength);
      let offset = 0;
      for (const part of matricesByGrid) {
        matrices.set(part, offset);
        offset += part.length;
      }

      source.thinInstanceSetBuffer("matrix", matrices, 16, true);
      this.activeMeshIds.add(meshId);
    }
  }
}

function buildGridContribution(cells: Int32Array): Map<string, Float32Array> {
  const groups = new Map<string, number[]>();
  const size = HEX_WIDTH / 2;
  const sqrt3 = Math.sqrt(3);
  const sizeTimesSqrt3 = size * sqrt3;
  const sizeTimesSqrt3Over2 = size * (sqrt3 / 2);
  const sizeTimesThreeOver2 = size * (3 / 2);
  const rotationStep = Math.PI / 3;
  const unitScale = new Vector3(1, 1, 1);

  for (let index = 0; index < cells.length; index += PACKED_GRID_STRIDE) {
    const q = cells[index];
    const r = cells[index + 1];
    const tileId = cells[index + 2];
    const rotation = cells[index + 3];
    const level = cells[index + 4];
    const tileDef = TILE_LIST[tileId];
    if (!tileDef) {
      continue;
    }

    const worldX = sizeTimesSqrt3 * q + sizeTimesSqrt3Over2 * r;
    const worldZ = sizeTimesThreeOver2 * r;
    const worldY = level * LEVEL_HEIGHT;
    const matrix = Matrix.Compose(
      unitScale,
      Quaternion.FromEulerAngles(0, rotation * rotationStep, 0),
      new Vector3(worldX, worldY, worldZ),
    );

    const bucket = groups.get(tileDef.mesh) ?? [];
    matrix.copyToArray(bucket, bucket.length);
    groups.set(tileDef.mesh, bucket);
  }

  return new Map(
    [...groups.entries()].map(([meshId, values]) => [meshId, new Float32Array(values)]),
  );
}
