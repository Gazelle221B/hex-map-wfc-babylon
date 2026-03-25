import type { HexDirection } from "./tile-def.js";

/**
 * Hex geometry constants (pointy-top orientation).
 */
export const HEX_WIDTH = 2;
export const HEX_HEIGHT = (2 / Math.sqrt(3)) * 2; // ≈ 2.3094
export const LEVEL_HEIGHT = 0.5;

/**
 * Cube coordinate neighbor offsets for the 6 hex directions.
 */
export const CUBE_DIRS: Readonly<Record<HexDirection, { readonly dq: number; readonly dr: number; readonly ds: number }>> = {
  NE: { dq: +1, dr: -1, ds: 0 },
  E: { dq: +1, dr: 0, ds: -1 },
  SE: { dq: 0, dr: +1, ds: -1 },
  SW: { dq: -1, dr: +1, ds: 0 },
  W: { dq: -1, dr: 0, ds: +1 },
  NW: { dq: 0, dr: -1, ds: +1 },
} as const;

/**
 * Hex neighbor offsets for odd-r offset coordinates (pointy-top).
 */
export const HEX_NEIGHBOR_OFFSETS = {
  even: {
    NE: { dx: 0, dz: -1 },
    E: { dx: 1, dz: 0 },
    SE: { dx: 0, dz: 1 },
    SW: { dx: -1, dz: 1 },
    W: { dx: -1, dz: 0 },
    NW: { dx: -1, dz: -1 },
  },
  odd: {
    NE: { dx: 1, dz: -1 },
    E: { dx: 1, dz: 0 },
    SE: { dx: 1, dz: 1 },
    SW: { dx: 0, dz: 1 },
    W: { dx: -1, dz: 0 },
    NW: { dx: 0, dz: -1 },
  },
} as const satisfies Readonly<
  Record<"even" | "odd", Readonly<Record<HexDirection, { readonly dx: number; readonly dz: number }>>>
>;
