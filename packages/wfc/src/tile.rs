use crate::hex::HexDir;

/// Edge types for hex tile adjacency.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum EdgeType {
    Grass,
    Water,
    Road,
    River,
    Coast,
}

/// A tile definition with 6 edge types, weight, and optional slope info.
#[derive(Clone, Debug)]
pub struct TileDef {
    pub id: u16,
    pub name: &'static str,
    pub mesh: &'static str,
    pub edges: [EdgeType; 6], // indexed by HexDir order (NE=0 .. NW=5)
    pub weight: f64,
    pub prevent_chaining: bool,
    pub high_edges: Option<&'static [usize]>, // dir indices that are elevated
    pub level_increment: u8,                   // 0 = flat, 1 = low slope, 2 = high slope
}

/// Number of elevation levels.
pub const LEVELS_COUNT: u8 = 5;
pub const WATER_TILE_ID: u16 = 1;

/// A specific tile state: tile type + rotation + elevation level.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct TileState {
    pub tile_id: u16,
    pub rotation: u8, // 0-5
    pub level: u8,    // 0-4
}

impl TileState {
    /// String key for Set/Map lookups: "tileId_rotation_level"
    pub fn key(&self) -> String {
        format!("{}_{}", self.tile_id, self.rotation)
    }

    /// Compact numeric key for fast comparison.
    pub fn compact_key(&self) -> u32 {
        (self.tile_id as u32) << 16 | (self.rotation as u32) << 8 | self.level as u32
    }
}

/// Get the effective edge type for a tile state in a given direction.
pub fn get_edge_type(tile: &TileDef, rotation: u8, dir: HexDir) -> EdgeType {
    let rotated_idx = (dir.index() + 6 - rotation as usize) % 6;
    tile.edges[rotated_idx]
}

/// Get the effective edge level for a tile state in a given direction.
/// Slopes have different levels on high vs low edges.
pub fn get_edge_level(tile: &TileDef, rotation: u8, dir: HexDir, base_level: u8) -> u8 {
    match &tile.high_edges {
        None => base_level,
        Some(high_dirs) => {
            // Check if this direction (after rotation) is a high edge
            let dir_idx = dir.index();
            let is_high = high_dirs.iter().any(|&h| {
                let rotated = (h + rotation as usize) % 6;
                rotated == dir_idx
            });
            if is_high {
                base_level + tile.level_increment
            } else {
                base_level
            }
        }
    }
}

/// Check if two edges are compatible (can be placed adjacent).
/// Grass connects at any level. Other types must match both type and level.
pub fn edges_compatible(
    edge_a: EdgeType,
    level_a: u8,
    edge_b: EdgeType,
    level_b: u8,
) -> bool {
    if edge_a != edge_b {
        return false;
    }
    if edge_a == EdgeType::Grass {
        return true;
    }
    level_a == level_b
}

/// Generate all valid tile states for the WFC system.
/// Each tile × 6 rotations × valid levels = state space.
pub fn generate_all_states(tiles: &[TileDef]) -> Vec<TileState> {
    let mut states = Vec::new();
    for tile in tiles {
        for rotation in 0..6u8 {
            let max_level = if tile.level_increment > 0 {
                LEVELS_COUNT - tile.level_increment
            } else {
                LEVELS_COUNT
            };
            for level in 0..max_level {
                states.push(TileState {
                    tile_id: tile.id,
                    rotation,
                    level,
                });
            }
        }
    }
    states
}

// --- Tile definitions (34 active tiles) ---
// High-edge direction indices: NE=0, E=1, SE=2, SW=3, W=4, NW=5

use EdgeType::*;

const HIGH_NE_E_SE: &[usize] = &[0, 1, 2];
const HIGH_E: &[usize] = &[1];

pub fn build_tile_list() -> Vec<TileDef> {
    let mut id = 0u16;
    let mut tile = |name, mesh, edges: [EdgeType; 6], weight, prevent_chaining, high_edges: Option<&'static [usize]>, level_increment| {
        let t = TileDef { id, name, mesh, edges, weight, prevent_chaining, high_edges, level_increment };
        id += 1;
        t
    };

    vec![
        // Base
        tile("GRASS", "hex_grass", [Grass, Grass, Grass, Grass, Grass, Grass], 500.0, false, None, 0),
        tile("WATER", "hex_water", [Water, Water, Water, Water, Water, Water], 500.0, false, None, 0),

        // Roads
        tile("ROAD_A", "hex_road_A", [Grass, Road, Grass, Grass, Road, Grass], 30.0, false, None, 0),
        tile("ROAD_B", "hex_road_B", [Road, Grass, Grass, Grass, Road, Grass], 8.0, false, None, 0),
        tile("ROAD_D", "hex_road_D", [Road, Grass, Road, Grass, Road, Grass], 2.0, true, None, 0),
        tile("ROAD_E", "hex_road_E", [Road, Road, Grass, Grass, Road, Grass], 2.0, true, None, 0),
        tile("ROAD_F", "hex_road_F", [Grass, Road, Road, Grass, Road, Grass], 2.0, true, None, 0),
        tile("ROAD_END", "hex_road_M", [Grass, Grass, Grass, Grass, Road, Grass], 1.0, true, None, 0),

        // Rivers
        tile("RIVER_A", "hex_river_A", [Grass, River, Grass, Grass, River, Grass], 20.0, false, None, 0),
        tile("RIVER_A_CURVY", "hex_river_A_curvy", [Grass, River, Grass, Grass, River, Grass], 20.0, false, None, 0),
        tile("RIVER_B", "hex_river_B", [River, Grass, Grass, Grass, River, Grass], 30.0, false, None, 0),
        tile("RIVER_D", "hex_river_D", [River, Grass, River, Grass, River, Grass], 4.0, true, None, 0),
        tile("RIVER_E", "hex_river_E", [River, River, Grass, Grass, River, Grass], 4.0, true, None, 0),
        tile("RIVER_F", "hex_river_F", [Grass, River, River, Grass, River, Grass], 4.0, true, None, 0),
        tile("RIVER_END", "river_end", [Grass, Grass, Grass, Grass, River, Grass], 4.0, true, None, 0),

        // Coasts
        tile("COAST_A", "hex_coast_A", [Grass, Coast, Water, Coast, Grass, Grass], 20.0, false, None, 0),
        tile("COAST_B", "hex_coast_B", [Grass, Coast, Water, Water, Coast, Grass], 15.0, false, None, 0),
        tile("COAST_C", "hex_coast_C", [Coast, Water, Water, Water, Coast, Grass], 15.0, false, None, 0),
        tile("COAST_D", "hex_coast_D", [Water, Water, Water, Water, Coast, Coast], 15.0, true, None, 0),
        tile("COAST_E", "hex_coast_E", [Grass, Grass, Coast, Coast, Grass, Grass], 10.0, true, None, 0),

        // Coast slopes
        tile("COAST_SLOPE_A_LOW", "coast_slope_low", [Grass, Grass, Grass, Coast, Water, Coast], 1.0, false, Some(HIGH_NE_E_SE), 1),
        tile("COAST_SLOPE_A_HIGH", "coast_slope_high", [Grass, Grass, Grass, Coast, Water, Coast], 1.0, false, Some(HIGH_NE_E_SE), 2),

        // River slope
        tile("RIVER_A_SLOPE_LOW", "river_slope_low", [Grass, River, Grass, Grass, River, Grass], 1.0, false, Some(HIGH_NE_E_SE), 1),

        // River-into-coast
        tile("RIVER_INTO_COAST", "river_coast", [Coast, Water, Water, Water, Coast, River], 3.0, true, None, 0),

        // Crossings
        tile("RIVER_CROSSING_A", "hex_river_crossing_A", [Grass, River, Road, Grass, River, Road], 4.0, true, None, 0),
        tile("RIVER_CROSSING_B", "hex_river_crossing_B", [Road, River, Grass, Road, River, Grass], 4.0, true, None, 0),

        // High slopes (2-level rise)
        tile("GRASS_SLOPE_HIGH", "hex_grass_sloped_high", [Grass, Grass, Grass, Grass, Grass, Grass], 20.0, false, Some(HIGH_NE_E_SE), 2),
        tile("ROAD_A_SLOPE_HIGH", "hex_road_A_sloped_high", [Grass, Road, Grass, Grass, Road, Grass], 12.0, false, Some(HIGH_NE_E_SE), 2),
        tile("GRASS_CLIFF", "hex_grass", [Grass, Grass, Grass, Grass, Grass, Grass], 6.0, false, Some(HIGH_NE_E_SE), 2),
        tile("GRASS_CLIFF_C", "hex_grass", [Grass, Grass, Grass, Grass, Grass, Grass], 6.0, false, Some(HIGH_E), 2),

        // Low slopes (1-level rise)
        tile("GRASS_SLOPE_LOW", "hex_grass_sloped_low", [Grass, Grass, Grass, Grass, Grass, Grass], 20.0, false, Some(HIGH_NE_E_SE), 1),
        tile("ROAD_A_SLOPE_LOW", "hex_road_A_sloped_low", [Grass, Road, Grass, Grass, Road, Grass], 12.0, false, Some(HIGH_NE_E_SE), 1),
        tile("GRASS_CLIFF_LOW", "hex_grass", [Grass, Grass, Grass, Grass, Grass, Grass], 6.0, false, Some(HIGH_NE_E_SE), 1),
        tile("GRASS_CLIFF_LOW_C", "hex_grass", [Grass, Grass, Grass, Grass, Grass, Grass], 6.0, false, Some(HIGH_E), 1),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tile_list_has_34_tiles() {
        assert_eq!(build_tile_list().len(), 34);
    }

    #[test]
    fn tile_ids_sequential() {
        let tiles = build_tile_list();
        for (i, tile) in tiles.iter().enumerate() {
            assert_eq!(tile.id as usize, i);
        }
    }

    #[test]
    fn grass_compatible_at_any_level() {
        assert!(edges_compatible(Grass, 0, Grass, 3));
        assert!(edges_compatible(Grass, 4, Grass, 0));
    }

    #[test]
    fn road_requires_same_level() {
        assert!(edges_compatible(Road, 2, Road, 2));
        assert!(!edges_compatible(Road, 0, Road, 1));
    }

    #[test]
    fn different_types_incompatible() {
        assert!(!edges_compatible(Grass, 0, Water, 0));
        assert!(!edges_compatible(Road, 1, River, 1));
    }

    #[test]
    fn edge_level_flat_tile() {
        let tiles = build_tile_list();
        let grass = &tiles[0]; // GRASS
        for dir in HexDir::ALL {
            assert_eq!(get_edge_level(grass, 0, dir, 2), 2);
        }
    }

    #[test]
    fn edge_level_slope_tile() {
        let tiles = build_tile_list();
        // GRASS_SLOPE_HIGH: highEdges=[NE,E,SE], levelIncrement=2
        let slope = tiles.iter().find(|t| t.name == "GRASS_SLOPE_HIGH").unwrap();
        // With rotation=0: NE,E,SE are high
        assert_eq!(get_edge_level(slope, 0, HexDir::NE, 0), 2);
        assert_eq!(get_edge_level(slope, 0, HexDir::E, 0), 2);
        assert_eq!(get_edge_level(slope, 0, HexDir::SE, 0), 2);
        // Low edges
        assert_eq!(get_edge_level(slope, 0, HexDir::SW, 0), 0);
        assert_eq!(get_edge_level(slope, 0, HexDir::W, 0), 0);
        assert_eq!(get_edge_level(slope, 0, HexDir::NW, 0), 0);
    }

    #[test]
    fn edge_level_rotated_slope() {
        let tiles = build_tile_list();
        let slope = tiles.iter().find(|t| t.name == "GRASS_SLOPE_HIGH").unwrap();
        // Rotation=1: high edges shift from [NE,E,SE] to [E,SE,SW]
        assert_eq!(get_edge_level(slope, 1, HexDir::E, 0), 2);
        assert_eq!(get_edge_level(slope, 1, HexDir::SE, 0), 2);
        assert_eq!(get_edge_level(slope, 1, HexDir::SW, 0), 2);
        assert_eq!(get_edge_level(slope, 1, HexDir::NE, 0), 0);
    }

    #[test]
    fn state_count_reasonable() {
        let tiles = build_tile_list();
        let states = generate_all_states(&tiles);
        // Flat tiles: 6 rotations × 5 levels = 30 per tile
        // Slope tiles: fewer levels
        assert!(states.len() > 500, "expected >500 states, got {}", states.len());
        assert!(states.len() < 2000, "expected <2000 states, got {}", states.len());
    }

    #[test]
    fn get_edge_type_with_rotation() {
        let tiles = build_tile_list();
        let road_a = &tiles[2]; // ROAD_A: edges = [Grass, Road, Grass, Grass, Road, Grass]
        // No rotation: E=Road, W=Road
        assert_eq!(get_edge_type(road_a, 0, HexDir::E), Road);
        assert_eq!(get_edge_type(road_a, 0, HexDir::W), Road);
        assert_eq!(get_edge_type(road_a, 0, HexDir::NE), Grass);
        // Rotation=1: road edges shift to SE and NW
        assert_eq!(get_edge_type(road_a, 1, HexDir::SE), Road);
        assert_eq!(get_edge_type(road_a, 1, HexDir::NW), Road);
    }
}
