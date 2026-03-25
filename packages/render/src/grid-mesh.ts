import { Mesh } from "@babylonjs/core";
import { TILE_LIST, type GridResult } from "@hex/types";
import type { TilePool } from "./tile-pool.js";

export class GridMeshLayer {
  private readonly meshes = new Map<number, Mesh>();

  constructor(private readonly tilePool: TilePool) {}

  addGrid(result: GridResult): void {
    this.removeGrid(result.gridIndex);

    const clones: Mesh[] = [];
    for (const cell of result.cells) {
      const tileDef = TILE_LIST[cell.tileId];
      if (!tileDef) {
        continue;
      }

      const template = this.tilePool.getTemplate(tileDef.mesh);
      const clone = template.clone(`grid-${result.gridIndex}-cell-${cell.q},${cell.r},${cell.s}`);
      if (!clone) {
        continue;
      }

      clone.isVisible = true;
      clone.isPickable = false;
      clone.position.set(cell.worldX, cell.worldY, cell.worldZ);
      clone.rotation.y = cell.rotation * (Math.PI / 3);
      clones.push(clone);
    }

    if (clones.length === 0) {
      return;
    }

    let merged: Mesh | null;
    try {
      merged = clones.length === 1
        ? clones[0]
        : Mesh.MergeMeshes(clones, true, true, undefined, false, true);
    } catch (error) {
      for (const clone of clones) {
        if (!clone.isDisposed()) {
          clone.dispose();
        }
      }
      throw error;
    }

    if (!merged) {
      for (const clone of clones) {
        if (!clone.isDisposed()) {
          clone.dispose();
        }
      }
      return;
    }

    merged.name = `grid-${result.gridIndex}`;
    merged.useVertexColors = true;
    merged.alwaysSelectAsActiveMesh = true;
    this.meshes.set(result.gridIndex, merged);
  }

  clear(): void {
    for (const mesh of this.meshes.values()) {
      mesh.dispose();
    }
    this.meshes.clear();
  }

  dispose(): void {
    this.clear();
  }

  private removeGrid(gridIndex: number): void {
    const mesh = this.meshes.get(gridIndex);
    if (mesh) {
      mesh.dispose();
      this.meshes.delete(gridIndex);
    }
  }
}
