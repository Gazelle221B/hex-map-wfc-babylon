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
