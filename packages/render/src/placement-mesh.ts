import {
  Matrix,
  Mesh,
  MeshBuilder,
  Quaternion,
  Vector3,
  type Scene,
} from "@babylonjs/core";
import {
  PACKED_PLACEMENT_STRIDE,
  resolvePlacementRenderSpec,
  type PackedPlacementChunk,
  type PlacementItem,
} from "@hex/types";
import {
  Color3,
  StandardMaterial,
  VertexBuffer,
} from "@babylonjs/core";

export class PlacementMeshLayer {
  private readonly contributions = new Map<number, Map<string, Float32Array>>();
  private readonly meshContributions = new Map<string, Map<number, Float32Array>>();
  private readonly dirtyMeshIds = new Set<string>();
  private readonly sources = new Map<string, Mesh>();
  private readonly material: StandardMaterial;
  private syncScheduled = false;
  private disposed = false;

  constructor(private readonly scene: Scene) {
    this.material = createVertexColorMaterial(scene, "placement-placeholder-material");
  }

  addPlacements(items: readonly PlacementItem[]): void {
    if (this.disposed) {
      return;
    }
    const nextContribution = buildPlacementContributionFromItems(items);
    const existingContribution = this.contributions.get(-1);
    this.replaceContribution(
      -1,
      existingContribution
        ? mergePlacementContributions(existingContribution, nextContribution)
        : nextContribution,
    );
    this.scheduleSync();
  }

  addPackedPlacements(chunk: PackedPlacementChunk): void {
    if (this.disposed) {
      return;
    }
    this.replaceContribution(
      chunk.gridIndex,
      buildPlacementContributionFromPacked(chunk.items),
    );
    this.scheduleSync();
  }

  clear(): void {
    if (this.disposed) {
      return;
    }
    for (const meshId of this.sources.keys()) {
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
    for (const source of this.sources.values()) {
      source.dispose();
    }
    this.sources.clear();
    this.contributions.clear();
    this.meshContributions.clear();
    this.dirtyMeshIds.clear();
    this.material.dispose();
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
      const source = this.getOrCreateSource(meshId);
      const entries = this.meshContributions.get(meshId);

      if (!entries || entries.size === 0) {
        source.thinInstanceSetBuffer("matrix", new Float32Array(0), 16, true);
        continue;
      }

      const matricesByGrid = [...entries.values()];
      const totalLength = matricesByGrid.reduce((sum, item) => sum + item.length, 0);
      const matrices = new Float32Array(totalLength);
      let offset = 0;
      for (const entry of matricesByGrid) {
        matrices.set(entry, offset);
        offset += entry.length;
      }

      source.thinInstanceSetBuffer("matrix", matrices, 16, true);
    }
  }

  private getOrCreateSource(meshId: string): Mesh {
    const existing = this.sources.get(meshId);
    if (existing) {
      return existing;
    }

    const source = createPlacementSource(this.scene, this.material, meshId);
    configureThinInstanceSource(source);
    this.sources.set(meshId, source);
    return source;
  }
}

function buildPlacementContributionFromPacked(items: Float32Array): Map<string, Float32Array> {
  const grouped = new Map<string, number[]>();

  for (let index = 0; index < items.length; index += PACKED_PLACEMENT_STRIDE) {
    const placementType = Math.round(items[index]);
    const tier = Math.round(items[index + 1]);
    const spec = resolvePlacementRenderSpec(placementType, tier);
    const matrix = Matrix.Compose(
      new Vector3(spec.scale, spec.scale, spec.scale),
      Quaternion.FromEulerAngles(0, items[index + 5], 0),
      new Vector3(items[index + 2], items[index + 3], items[index + 4]),
    );
    const bucket = grouped.get(spec.meshId) ?? [];
    matrix.copyToArray(bucket, bucket.length);
    grouped.set(spec.meshId, bucket);
  }

  return new Map(
    [...grouped.entries()].map(([meshId, values]) => [meshId, new Float32Array(values)]),
  );
}

function buildPlacementContributionFromItems(items: readonly PlacementItem[]): Map<string, Float32Array> {
  const grouped = new Map<string, number[]>();

  items.forEach((item) => {
    const matrix = Matrix.Compose(
      new Vector3(item.scale, item.scale, item.scale),
      Quaternion.FromEulerAngles(0, item.rotationY, 0),
      new Vector3(item.worldX, item.worldY, item.worldZ),
    );
    const bucket = grouped.get(item.meshId) ?? [];
    matrix.copyToArray(bucket, bucket.length);
    grouped.set(item.meshId, bucket);
  });

  return new Map(
    [...grouped.entries()].map(([meshId, values]) => [meshId, new Float32Array(values)]),
  );
}

function mergePlacementContributions(
  existing: ReadonlyMap<string, Float32Array>,
  next: ReadonlyMap<string, Float32Array>,
): Map<string, Float32Array> {
  const merged = new Map<string, Float32Array>();
  const keys = new Set([...existing.keys(), ...next.keys()]);

  for (const key of keys) {
    const left = existing.get(key);
    const right = next.get(key);

    if (!left) {
      merged.set(key, right!.slice());
      continue;
    }

    if (!right) {
      merged.set(key, left.slice());
      continue;
    }

    const combined = new Float32Array(left.length + right.length);
    combined.set(left, 0);
    combined.set(right, left.length);
    merged.set(key, combined);
  }

  return merged;
}

function createPlacementSource(scene: Scene, material: StandardMaterial, meshId: string): Mesh {
  switch (meshId) {
    case "tree_a":
      return mergeParts(
        "tree-a",
        [
          createColoredCylinder(scene, material, "tree-a-trunk", { height: 0.45, diameterTop: 0.12, diameterBottom: 0.16 }, new Color3(0.35, 0.24, 0.15), 0.225),
          createColoredSphere(scene, material, "tree-a-canopy", 0.54, new Color3(0.28, 0.6, 0.26), 0.72),
        ],
      );
    case "tree_b":
      return mergeParts(
        "tree-b",
        [
          createColoredCylinder(scene, material, "tree-b-trunk", { height: 0.38, diameterTop: 0.1, diameterBottom: 0.14 }, new Color3(0.39, 0.25, 0.12), 0.19),
          createColoredCylinder(scene, material, "tree-b-canopy", { height: 0.82, diameterTop: 0, diameterBottom: 0.68, tessellation: 8 }, new Color3(0.18, 0.48, 0.2), 0.76),
        ],
      );
    case "building":
      return mergeParts(
        "building",
        [
          createColoredBox(scene, material, "building-body", { width: 0.6, height: 0.52, depth: 0.6 }, new Color3(0.82, 0.78, 0.69), 0.26),
          createColoredCylinder(scene, material, "building-roof", { height: 0.28, diameterTop: 0, diameterBottom: 0.82, tessellation: 4 }, new Color3(0.68, 0.28, 0.21), 0.66),
        ],
      );
    case "windmill":
      return mergeParts(
        "windmill",
        [
          createColoredCylinder(scene, material, "windmill-body", { height: 0.78, diameterTop: 0.16, diameterBottom: 0.26 }, new Color3(0.86, 0.83, 0.74), 0.39),
          createColoredBox(scene, material, "windmill-blade-a", { width: 0.7, height: 0.06, depth: 0.08 }, new Color3(0.92, 0.9, 0.86), 0.88, 0.12),
          createColoredBox(scene, material, "windmill-blade-b", { width: 0.06, height: 0.7, depth: 0.08 }, new Color3(0.92, 0.9, 0.86), 0.88, 0.12),
        ],
      );
    default:
      return createColoredBox(scene, material, `placement-${meshId}`, { width: 0.32, height: 0.32, depth: 0.32 }, new Color3(0.8, 0.2, 0.7), 0.16);
  }
}

function configureThinInstanceSource(mesh: Mesh): void {
  mesh.isVisible = true;
  mesh.isPickable = false;
  mesh.alwaysSelectAsActiveMesh = true;

  const internalData = (mesh as Mesh & {
    _internalAbstractMeshDataInfo?: {
      _onlyForInstances?: boolean;
      _onlyForInstancesIntermediate?: boolean;
    };
  })._internalAbstractMeshDataInfo;

  if (internalData) {
    internalData._onlyForInstances = true;
    internalData._onlyForInstancesIntermediate = true;
  }
}

function mergeParts(name: string, parts: Mesh[]): Mesh {
  try {
    const merged = Mesh.MergeMeshes(parts, true, true, undefined, false, true);
    if (!merged) {
      throw new Error(`failed to merge placeholder placement mesh: ${name}`);
    }
    merged.name = name;
    merged.useVertexColors = true;
    return merged;
  } catch (error) {
    for (const part of parts) {
      if (!part.isDisposed()) {
        part.dispose();
      }
    }
    throw error;
  }
}

function createColoredBox(
  scene: Scene,
  material: StandardMaterial,
  name: string,
  options: { width: number; height: number; depth: number },
  color: Color3,
  y: number,
  z = 0,
): Mesh {
  const mesh = MeshBuilder.CreateBox(name, options, scene);
  mesh.position.set(0, y, z);
  mesh.bakeCurrentTransformIntoVertices();
  applySolidVertexColor(mesh, color);
  mesh.material = material;
  mesh.useVertexColors = true;
  return mesh;
}

function createColoredSphere(
  scene: Scene,
  material: StandardMaterial,
  name: string,
  diameter: number,
  color: Color3,
  y: number,
): Mesh {
  const mesh = MeshBuilder.CreateSphere(name, { diameter }, scene);
  mesh.position.y = y;
  mesh.bakeCurrentTransformIntoVertices();
  applySolidVertexColor(mesh, color);
  mesh.material = material;
  mesh.useVertexColors = true;
  return mesh;
}

function createColoredCylinder(
  scene: Scene,
  material: StandardMaterial,
  name: string,
  options: { height: number; diameterTop?: number; diameterBottom?: number; tessellation?: number },
  color: Color3,
  y: number,
): Mesh {
  const mesh = MeshBuilder.CreateCylinder(name, options, scene);
  mesh.position.y = y;
  mesh.bakeCurrentTransformIntoVertices();
  applySolidVertexColor(mesh, color);
  mesh.material = material;
  mesh.useVertexColors = true;
  return mesh;
}

function createVertexColorMaterial(scene: Scene, name: string): StandardMaterial {
  const material = new StandardMaterial(name, scene);
  material.diffuseColor = Color3.White();
  material.specularColor = Color3.Black();
  return material;
}

function applySolidVertexColor(mesh: Mesh, color: Color3): void {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  const vertexCount = positions ? positions.length / 3 : 0;
  const colors = new Float32Array(vertexCount * 4);

  for (let i = 0; i < vertexCount; i += 1) {
    const offset = i * 4;
    colors[offset] = color.r;
    colors[offset + 1] = color.g;
    colors[offset + 2] = color.b;
    colors[offset + 3] = 1;
  }

  mesh.setVerticesData(VertexBuffer.ColorKind, colors, true);
}
