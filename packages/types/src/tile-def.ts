/**
 * Edge types for hex tile adjacency rules.
 * These 5 types determine which tiles can be placed next to each other.
 */
export type EdgeType = "grass" | "water" | "road" | "river" | "coast";

/**
 * The 6 directions of a pointy-top hexagon.
 */
export type HexDirection = "NE" | "E" | "SE" | "SW" | "W" | "NW";

export const HEX_DIRECTIONS: readonly HexDirection[] = [
  "NE",
  "E",
  "SE",
  "SW",
  "W",
  "NW",
] as const;

/**
 * Opposite direction mapping for constraint propagation.
 */
export const HEX_OPPOSITE: Readonly<Record<HexDirection, HexDirection>> = {
  NE: "SW",
  E: "W",
  SE: "NW",
  SW: "NE",
  W: "E",
  NW: "SE",
} as const;

/**
 * Edge types for all 6 hex directions.
 */
export type HexEdges = Readonly<Record<HexDirection, EdgeType>>;

/**
 * Debug visualization metadata for a tile (optional).
 */
export interface TileDebug {
  readonly color: number;
  readonly stripe?: string;
  readonly yOffset?: number;
}

/**
 * A tile definition in the WFC system.
 * Array index in TILE_LIST is the tile's numeric ID.
 */
export interface TileDef {
  readonly name: string;
  readonly mesh: string;
  readonly edges: HexEdges;
  readonly weight: number;
  readonly preventChaining?: boolean;
  readonly highEdges?: readonly HexDirection[];
  readonly levelIncrement?: number;
  readonly debug?: TileDebug;
}

/**
 * Number of elevation levels in the WFC system.
 */
export const LEVELS_COUNT = 5;

/**
 * All 34 active tile definitions.
 * Array index IS the tile's numeric ID.
 * Ported faithfully from the original HexTileData.js.
 */
export const TILE_LIST: readonly TileDef[] = [
  // --- Base ---
  {
    name: "GRASS",
    mesh: "hex_grass",
    edges: { NE: "grass", E: "grass", SE: "grass", SW: "grass", W: "grass", NW: "grass" },
    weight: 500,
  },
  {
    name: "WATER",
    mesh: "hex_water",
    edges: { NE: "water", E: "water", SE: "water", SW: "water", W: "water", NW: "water" },
    weight: 500,
  },

  // --- Roads ---
  {
    name: "ROAD_A",
    mesh: "hex_road_A",
    edges: { NE: "grass", E: "road", SE: "grass", SW: "grass", W: "road", NW: "grass" },
    weight: 30,
  },
  {
    name: "ROAD_B",
    mesh: "hex_road_B",
    edges: { NE: "road", E: "grass", SE: "grass", SW: "grass", W: "road", NW: "grass" },
    weight: 8,
  },
  {
    name: "ROAD_D",
    mesh: "hex_road_D",
    edges: { NE: "road", E: "grass", SE: "road", SW: "grass", W: "road", NW: "grass" },
    weight: 2,
    preventChaining: true,
  },
  {
    name: "ROAD_E",
    mesh: "hex_road_E",
    edges: { NE: "road", E: "road", SE: "grass", SW: "grass", W: "road", NW: "grass" },
    weight: 2,
    preventChaining: true,
  },
  {
    name: "ROAD_F",
    mesh: "hex_road_F",
    edges: { NE: "grass", E: "road", SE: "road", SW: "grass", W: "road", NW: "grass" },
    weight: 2,
    preventChaining: true,
  },
  {
    name: "ROAD_END",
    mesh: "hex_road_M",
    edges: { NE: "grass", E: "grass", SE: "grass", SW: "grass", W: "road", NW: "grass" },
    weight: 1,
    preventChaining: true,
  },

  // --- Rivers ---
  {
    name: "RIVER_A",
    mesh: "hex_river_A",
    edges: { NE: "grass", E: "river", SE: "grass", SW: "grass", W: "river", NW: "grass" },
    weight: 20,
  },
  {
    name: "RIVER_A_CURVY",
    mesh: "hex_river_A_curvy",
    edges: { NE: "grass", E: "river", SE: "grass", SW: "grass", W: "river", NW: "grass" },
    weight: 20,
  },
  {
    name: "RIVER_B",
    mesh: "hex_river_B",
    edges: { NE: "river", E: "grass", SE: "grass", SW: "grass", W: "river", NW: "grass" },
    weight: 30,
  },
  {
    name: "RIVER_D",
    mesh: "hex_river_D",
    edges: { NE: "river", E: "grass", SE: "river", SW: "grass", W: "river", NW: "grass" },
    weight: 4,
    preventChaining: true,
  },
  {
    name: "RIVER_E",
    mesh: "hex_river_E",
    edges: { NE: "river", E: "river", SE: "grass", SW: "grass", W: "river", NW: "grass" },
    weight: 4,
    preventChaining: true,
  },
  {
    name: "RIVER_F",
    mesh: "hex_river_F",
    edges: { NE: "grass", E: "river", SE: "river", SW: "grass", W: "river", NW: "grass" },
    weight: 4,
    preventChaining: true,
  },
  {
    name: "RIVER_END",
    mesh: "river_end",
    edges: { NE: "grass", E: "grass", SE: "grass", SW: "grass", W: "river", NW: "grass" },
    weight: 4,
    preventChaining: true,
    debug: { color: 0xff0000, stripe: "W" },
  },

  // --- Coasts ---
  {
    name: "COAST_A",
    mesh: "hex_coast_A",
    edges: { NE: "grass", E: "coast", SE: "water", SW: "coast", W: "grass", NW: "grass" },
    weight: 20,
  },
  {
    name: "COAST_B",
    mesh: "hex_coast_B",
    edges: { NE: "grass", E: "coast", SE: "water", SW: "water", W: "coast", NW: "grass" },
    weight: 15,
  },
  {
    name: "COAST_C",
    mesh: "hex_coast_C",
    edges: { NE: "coast", E: "water", SE: "water", SW: "water", W: "coast", NW: "grass" },
    weight: 15,
  },
  {
    name: "COAST_D",
    mesh: "hex_coast_D",
    edges: { NE: "water", E: "water", SE: "water", SW: "water", W: "coast", NW: "coast" },
    weight: 15,
    preventChaining: true,
  },
  {
    name: "COAST_E",
    mesh: "hex_coast_E",
    edges: { NE: "grass", E: "grass", SE: "coast", SW: "coast", W: "grass", NW: "grass" },
    weight: 10,
    preventChaining: true,
  },

  // --- Coast slopes ---
  {
    name: "COAST_SLOPE_A_LOW",
    mesh: "coast_slope_low",
    edges: { NE: "grass", E: "grass", SE: "grass", SW: "coast", W: "water", NW: "coast" },
    weight: 1,
    highEdges: ["NE", "E", "SE"],
    levelIncrement: 1,
    debug: { color: 0xff0000, stripe: "W" },
  },
  {
    name: "COAST_SLOPE_A_HIGH",
    mesh: "coast_slope_high",
    edges: { NE: "grass", E: "grass", SE: "grass", SW: "coast", W: "water", NW: "coast" },
    weight: 1,
    highEdges: ["NE", "E", "SE"],
    levelIncrement: 2,
    debug: { color: 0xff0000, stripe: "W", yOffset: 0.5 },
  },

  // --- River slope ---
  {
    name: "RIVER_A_SLOPE_LOW",
    mesh: "river_slope_low",
    edges: { NE: "grass", E: "river", SE: "grass", SW: "grass", W: "river", NW: "grass" },
    weight: 1,
    highEdges: ["NE", "E", "SE"],
    levelIncrement: 1,
    debug: { color: 0xff0000, stripe: "W" },
  },

  // --- River-into-coast ---
  {
    name: "RIVER_INTO_COAST",
    mesh: "river_coast",
    edges: { NE: "coast", E: "water", SE: "water", SW: "water", W: "coast", NW: "river" },
    weight: 3,
    preventChaining: true,
    debug: { color: 0xff0000, stripe: "NW" },
  },

  // --- Crossings ---
  {
    name: "RIVER_CROSSING_A",
    mesh: "hex_river_crossing_A",
    edges: { NE: "grass", E: "river", SE: "road", SW: "grass", W: "river", NW: "road" },
    weight: 4,
    preventChaining: true,
  },
  {
    name: "RIVER_CROSSING_B",
    mesh: "hex_river_crossing_B",
    edges: { NE: "road", E: "river", SE: "grass", SW: "road", W: "river", NW: "grass" },
    weight: 4,
    preventChaining: true,
  },

  // --- High slopes (2-level rise) ---
  {
    name: "GRASS_SLOPE_HIGH",
    mesh: "hex_grass_sloped_high",
    edges: { NE: "grass", E: "grass", SE: "grass", SW: "grass", W: "grass", NW: "grass" },
    weight: 20,
    highEdges: ["NE", "E", "SE"],
    levelIncrement: 2,
  },
  {
    name: "ROAD_A_SLOPE_HIGH",
    mesh: "hex_road_A_sloped_high",
    edges: { NE: "grass", E: "road", SE: "grass", SW: "grass", W: "road", NW: "grass" },
    weight: 12,
    highEdges: ["NE", "E", "SE"],
    levelIncrement: 2,
  },
  {
    name: "GRASS_CLIFF",
    mesh: "hex_grass",
    edges: { NE: "grass", E: "grass", SE: "grass", SW: "grass", W: "grass", NW: "grass" },
    weight: 6,
    highEdges: ["NE", "E", "SE"],
    levelIncrement: 2,
  },
  {
    name: "GRASS_CLIFF_C",
    mesh: "hex_grass",
    edges: { NE: "grass", E: "grass", SE: "grass", SW: "grass", W: "grass", NW: "grass" },
    weight: 6,
    highEdges: ["E"],
    levelIncrement: 2,
  },

  // --- Low slopes (1-level rise) ---
  {
    name: "GRASS_SLOPE_LOW",
    mesh: "hex_grass_sloped_low",
    edges: { NE: "grass", E: "grass", SE: "grass", SW: "grass", W: "grass", NW: "grass" },
    weight: 20,
    highEdges: ["NE", "E", "SE"],
    levelIncrement: 1,
  },
  {
    name: "ROAD_A_SLOPE_LOW",
    mesh: "hex_road_A_sloped_low",
    edges: { NE: "grass", E: "road", SE: "grass", SW: "grass", W: "road", NW: "grass" },
    weight: 12,
    highEdges: ["NE", "E", "SE"],
    levelIncrement: 1,
  },
  {
    name: "GRASS_CLIFF_LOW",
    mesh: "hex_grass",
    edges: { NE: "grass", E: "grass", SE: "grass", SW: "grass", W: "grass", NW: "grass" },
    weight: 6,
    highEdges: ["NE", "E", "SE"],
    levelIncrement: 1,
  },
  {
    name: "GRASS_CLIFF_LOW_C",
    mesh: "hex_grass",
    edges: { NE: "grass", E: "grass", SE: "grass", SW: "grass", W: "grass", NW: "grass" },
    weight: 6,
    highEdges: ["E"],
    levelIncrement: 1,
  },
] as const;

/**
 * Name → index lookup derived from TILE_LIST.
 * e.g. TILE_TYPE.GRASS === 0, TILE_TYPE.WATER === 1
 */
export const TILE_TYPE: Readonly<Record<string, number>> = Object.fromEntries(
  TILE_LIST.map((t, i) => [t.name, i]),
);
