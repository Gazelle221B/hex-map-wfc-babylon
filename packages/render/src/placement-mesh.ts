import {
  Color3,
  Matrix,
  Mesh,
  MeshBuilder,
  Quaternion,
  StandardMaterial,
  Vector3,
  VertexBuffer,
  type Scene,
} from "@babylonjs/core";
import type { PlacementItem } from "@hex/types";

export class PlacementMeshLayer {
  private readonly items: PlacementItem[] = [];
  private readonly sources = new Map<string, Mesh>();

  constructor(private readonly scene: Scene) {}

  addPlacements(items: readonly PlacementItem[]): void {
    this.items.push(...items);
    this.sync();
  }

  clear(): void {
    this.items.length = 0;
    for (const source of this.sources.values()) {
      source.thinInstanceSetBuffer("matrix", new Float32Array(0), 16, true);
    }
  }

  dispose(): void {
    for (const source of this.sources.values()) {
      source.dispose();
    }
    this.sources.clear();
    this.items.length = 0;
  }

  private sync(): void {
    const grouped = new Map<string, PlacementItem[]>();
    for (const item of this.items) {
      const bucket = grouped.get(item.meshId);
      if (bucket) {
        bucket.push(item);
      } else {
        grouped.set(item.meshId, [item]);
      }
    }

    const knownKeys = new Set([...grouped.keys(), ...this.sources.keys()]);
    for (const meshId of knownKeys) {
      const source = this.getOrCreateSource(meshId);
      const entries = grouped.get(meshId) ?? [];

      if (entries.length === 0) {
        source.thinInstanceSetBuffer("matrix", new Float32Array(0), 16, true);
        continue;
      }

      const matrices = new Float32Array(entries.length * 16);
      entries.forEach((item, index) => {
        const matrix = Matrix.Compose(
          new Vector3(item.scale, item.scale, item.scale),
          Quaternion.FromEulerAngles(0, item.rotationY, 0),
          new Vector3(item.worldX, item.worldY, item.worldZ),
        );
        matrix.copyToArray(matrices, index * 16);
      });

      source.thinInstanceSetBuffer("matrix", matrices, 16, true);
    }
  }

  private getOrCreateSource(meshId: string): Mesh {
    const existing = this.sources.get(meshId);
    if (existing) {
      return existing;
    }

    const source = createPlacementSource(this.scene, meshId);
    source.isVisible = false;
    source.isPickable = false;
    source.alwaysSelectAsActiveMesh = true;
    this.sources.set(meshId, source);
    return source;
  }
}

function createPlacementSource(scene: Scene, meshId: string): Mesh {
  switch (meshId) {
    case "tree_a":
      return mergeParts(
        "tree-a",
        [
          createColoredCylinder(scene, "tree-a-trunk", { height: 0.45, diameterTop: 0.12, diameterBottom: 0.16 }, new Color3(0.35, 0.24, 0.15), 0.225),
          createColoredSphere(scene, "tree-a-canopy", 0.54, new Color3(0.28, 0.6, 0.26), 0.72),
        ],
      );
    case "tree_b":
      return mergeParts(
        "tree-b",
        [
          createColoredCylinder(scene, "tree-b-trunk", { height: 0.38, diameterTop: 0.1, diameterBottom: 0.14 }, new Color3(0.39, 0.25, 0.12), 0.19),
          createColoredCylinder(scene, "tree-b-canopy", { height: 0.82, diameterTop: 0, diameterBottom: 0.68, tessellation: 8 }, new Color3(0.18, 0.48, 0.2), 0.76),
        ],
      );
    case "building":
      return mergeParts(
        "building",
        [
          createColoredBox(scene, "building-body", { width: 0.6, height: 0.52, depth: 0.6 }, new Color3(0.82, 0.78, 0.69), 0.26),
          createColoredCylinder(scene, "building-roof", { height: 0.28, diameterTop: 0, diameterBottom: 0.82, tessellation: 4 }, new Color3(0.68, 0.28, 0.21), 0.66),
        ],
      );
    case "windmill":
      return mergeParts(
        "windmill",
        [
          createColoredCylinder(scene, "windmill-body", { height: 0.78, diameterTop: 0.16, diameterBottom: 0.26 }, new Color3(0.86, 0.83, 0.74), 0.39),
          createColoredBox(scene, "windmill-blade-a", { width: 0.7, height: 0.06, depth: 0.08 }, new Color3(0.92, 0.9, 0.86), 0.88, 0.12),
          createColoredBox(scene, "windmill-blade-b", { width: 0.06, height: 0.7, depth: 0.08 }, new Color3(0.92, 0.9, 0.86), 0.88, 0.12),
        ],
      );
    default:
      return createColoredBox(scene, `placement-${meshId}`, { width: 0.32, height: 0.32, depth: 0.32 }, new Color3(0.8, 0.2, 0.7), 0.16);
  }
}

function mergeParts(name: string, parts: Mesh[]): Mesh {
  const merged = Mesh.MergeMeshes(parts, true, true, undefined, false, true);
  if (!merged) {
    throw new Error(`failed to merge placeholder placement mesh: ${name}`);
  }
  merged.name = name;
  merged.useVertexColors = true;
  return merged;
}

function createColoredBox(
  scene: Scene,
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
  mesh.material = createVertexColorMaterial(scene, `${name}-mat`);
  mesh.useVertexColors = true;
  return mesh;
}

function createColoredSphere(
  scene: Scene,
  name: string,
  diameter: number,
  color: Color3,
  y: number,
): Mesh {
  const mesh = MeshBuilder.CreateSphere(name, { diameter }, scene);
  mesh.position.y = y;
  mesh.bakeCurrentTransformIntoVertices();
  applySolidVertexColor(mesh, color);
  mesh.material = createVertexColorMaterial(scene, `${name}-mat`);
  mesh.useVertexColors = true;
  return mesh;
}

function createColoredCylinder(
  scene: Scene,
  name: string,
  options: { height: number; diameterTop?: number; diameterBottom?: number; tessellation?: number },
  color: Color3,
  y: number,
): Mesh {
  const mesh = MeshBuilder.CreateCylinder(name, options, scene);
  mesh.position.y = y;
  mesh.bakeCurrentTransformIntoVertices();
  applySolidVertexColor(mesh, color);
  mesh.material = createVertexColorMaterial(scene, `${name}-mat`);
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
