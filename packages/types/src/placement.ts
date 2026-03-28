/**
 * Types of decorations that can be placed on the map.
 */
export type PlacementType =
  | "tree"
  | "building"
  | "windmill"
  | "bridge"
  | "waterlily"
  | "flower"
  | "rock"
  | "hill"
  | "mountain";

/**
 * A single decoration placement on the map.
 * Produced by the Rust placement engine (position/type)
 * and consumed by the TS renderer (mesh instantiation).
 */
export interface PlacementItem {
  readonly type: PlacementType;
  readonly meshId: string;
  readonly worldX: number;
  readonly worldY: number;
  readonly worldZ: number;
  readonly rotationY: number;
  readonly scale: number;
}

export interface PlacementRenderSpec {
  readonly type: PlacementType;
  readonly meshId: string;
  readonly scale: number;
}

export const PACKED_PLACEMENT_STRIDE = 6;

/**
 * Packed placement payload emitted from the worker.
 * Stride: [placementType, tier, worldX, worldY, worldZ, rotation]
 */
export interface PackedPlacementChunk {
  readonly gridIndex: number;
  readonly items: Float32Array;
}

export function resolvePlacementRenderSpec(
  placementType: number,
  tier: number,
): PlacementRenderSpec {
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
