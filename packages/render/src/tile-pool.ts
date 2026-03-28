import {
  Color3,
  Mesh,
  MeshBuilder,
  StandardMaterial,
  VertexBuffer,
  type Scene,
} from "@babylonjs/core";
import { TILE_LIST } from "@hex/types";

interface TileStyle {
  readonly color: Color3;
  readonly height: number;
  readonly diameterTop: number;
  readonly diameterBottom: number;
}

export interface TilePool {
  getTemplate(meshId: string): Mesh;
  dispose(): void;
}

export function createTilePool(scene: Scene): TilePool {
  const material = new StandardMaterial("tile-placeholder-material", scene);
  material.diffuseColor = Color3.White();
  material.specularColor = Color3.Black();

  const templates = new Map<string, Mesh>();
  const meshIds = new Set(TILE_LIST.map((tile) => tile.mesh));
  for (const meshId of meshIds) {
    const template = createTemplateMesh(scene, meshId, material);
    templates.set(meshId, template);
  }

  return {
    getTemplate(meshId) {
      const template = templates.get(meshId);
      if (!template) {
        throw new Error(`missing tile template for mesh id: ${meshId}`);
      }
      return template;
    },
    dispose() {
      for (const template of templates.values()) {
        template.dispose();
      }
      material.dispose();
    },
  };
}

function createTemplateMesh(scene: Scene, meshId: string, material: StandardMaterial): Mesh {
  const style = resolveTileStyle(meshId);
  const mesh = MeshBuilder.CreateCylinder(`tile-template-${meshId}`, {
    height: style.height,
    diameterTop: style.diameterTop,
    diameterBottom: style.diameterBottom,
    tessellation: 6,
  }, scene);

  mesh.rotation.y = Math.PI / 6;
  mesh.position.y = style.height / 2;
  mesh.bakeCurrentTransformIntoVertices();
  applySolidVertexColor(mesh, style.color);
  mesh.material = material;
  mesh.useVertexColors = true;
  configureThinInstanceSource(mesh);

  return mesh;
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

function resolveTileStyle(meshId: string): TileStyle {
  if (meshId === "hex_water") {
    return {
      color: new Color3(0.17, 0.46, 0.74),
      height: 0.12,
      diameterTop: 1.9,
      diameterBottom: 1.95,
    };
  }

  if (meshId.startsWith("hex_road") || meshId === "hex_river_crossing_A" || meshId === "hex_river_crossing_B") {
    return {
      color: new Color3(0.45, 0.46, 0.43),
      height: meshId.includes("sloped_high") ? 0.74 : meshId.includes("sloped_low") ? 0.54 : 0.32,
      diameterTop: 1.82,
      diameterBottom: 1.95,
    };
  }

  if (meshId.startsWith("hex_river") || meshId === "river_end" || meshId === "river_slope_low" || meshId === "river_coast") {
    return {
      color: new Color3(0.21, 0.6, 0.58),
      height: meshId.includes("slope") ? 0.52 : 0.28,
      diameterTop: 1.84,
      diameterBottom: 1.95,
    };
  }

  if (meshId.startsWith("hex_coast") || meshId.startsWith("coast_slope")) {
    return {
      color: new Color3(0.85, 0.77, 0.55),
      height: meshId.includes("_high") ? 0.78 : meshId.includes("_low") ? 0.56 : 0.3,
      diameterTop: 1.86,
      diameterBottom: 1.95,
    };
  }

  if (meshId.includes("sloped_high")) {
    return {
      color: new Color3(0.58, 0.76, 0.45),
      height: 0.82,
      diameterTop: 1.75,
      diameterBottom: 1.95,
    };
  }

  if (meshId.includes("sloped_low")) {
    return {
      color: new Color3(0.48, 0.73, 0.43),
      height: 0.58,
      diameterTop: 1.8,
      diameterBottom: 1.95,
    };
  }

  return {
    color: new Color3(0.36, 0.68, 0.34),
    height: 0.34,
    diameterTop: 1.9,
    diameterBottom: 1.95,
  };
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
