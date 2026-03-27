import { Matrix, Quaternion, Vector3 } from "@babylonjs/core";
import {
  HEX_WIDTH,
  LEVEL_HEIGHT,
  TILE_LIST,
  type GridResult,
  type PackedGridChunk,
} from "@hex/types";
import type { TilePool } from "./tile-pool.js";

export class GridMeshLayer {
  private readonly contributions = new Map<number, Map<string, Float32Array>>();
  private readonly activeMeshIds = new Set<string>();

  constructor(private readonly tilePool: TilePool) {}

  addGrid(result: GridResult): void {
    const stride = 5;
    const cells = new Int32Array(result.cells.length * stride);
    result.cells.forEach((cell, index) => {
      const offset = index * stride;
      cells[offset] = cell.q;
      cells[offset + 1] = cell.r;
      cells[offset + 2] = cell.tileId;
      cells[offset + 3] = cell.rotation;
      cells[offset + 4] = cell.elevation;
    });
    this.addPackedGrid({
      gridIndex: result.gridIndex,
      status: "solved",
      cells,
    });
  }

  addPackedGrid(chunk: PackedGridChunk): void {
    this.contributions.set(chunk.gridIndex, buildGridContribution(chunk.cells));
    this.sync();
  }

  clear(): void {
    this.contributions.clear();
    this.sync();
  }

  dispose(): void {
    this.clear();
  }

  private sync(): void {
    const nextActiveMeshIds = new Set<string>();
    const grouped = new Map<string, Float32Array[]>();

    for (const contribution of this.contributions.values()) {
      for (const [meshId, matrices] of contribution.entries()) {
        nextActiveMeshIds.add(meshId);
        const bucket = grouped.get(meshId);
        if (bucket) {
          bucket.push(matrices);
        } else {
          grouped.set(meshId, [matrices]);
        }
      }
    }

    const knownMeshIds = new Set([...this.activeMeshIds, ...nextActiveMeshIds]);
    for (const meshId of knownMeshIds) {
      const source = this.tilePool.getTemplate(meshId);
      const parts = grouped.get(meshId) ?? [];

      if (parts.length === 0) {
        source.thinInstanceSetBuffer("matrix", new Float32Array(0), 16, true);
        continue;
      }

      const totalLength = parts.reduce((sum, item) => sum + item.length, 0);
      const matrices = new Float32Array(totalLength);
      let offset = 0;
      for (const part of parts) {
        matrices.set(part, offset);
        offset += part.length;
      }

      source.thinInstanceSetBuffer("matrix", matrices, 16, true);
    }

    this.activeMeshIds.clear();
    for (const meshId of nextActiveMeshIds) {
      this.activeMeshIds.add(meshId);
    }
  }
}

function buildGridContribution(cells: Int32Array): Map<string, Float32Array> {
  const stride = 5;
  const groups = new Map<string, number[]>();
  const size = HEX_WIDTH / 2;

  for (let index = 0; index < cells.length; index += stride) {
    const q = cells[index];
    const r = cells[index + 1];
    const tileId = cells[index + 2];
    const rotation = cells[index + 3];
    const level = cells[index + 4];
    const tileDef = TILE_LIST[tileId];
    if (!tileDef) {
      continue;
    }

    const worldX = size * (Math.sqrt(3) * q + Math.sqrt(3) / 2 * r);
    const worldZ = size * (3 / 2 * r);
    const worldY = level * LEVEL_HEIGHT;
    const matrix = Matrix.Compose(
      Vector3.One(),
      Quaternion.FromEulerAngles(0, rotation * (Math.PI / 3), 0),
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
