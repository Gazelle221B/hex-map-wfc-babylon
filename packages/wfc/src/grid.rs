use std::collections::{HashMap, HashSet};

use crate::hex::{CubeCoord, HexDir};
use crate::tile::{
    build_tile_list, generate_all_states, get_edge_level, get_edge_type,
    TileDef, TileState,
};

/// A single cell in the WFC grid, tracking possible states.
#[derive(Clone, Debug)]
pub struct WfcCell {
    pub coord: CubeCoord,
    pub possibilities: HashSet<u32>, // compact keys of TileState
    pub collapsed: bool,
    pub tile: Option<TileState>,
}

impl WfcCell {
    pub fn new(coord: CubeCoord, all_states: &[u32]) -> Self {
        Self {
            coord,
            possibilities: all_states.iter().copied().collect(),
            collapsed: false,
            tile: None,
        }
    }

    pub fn entropy(&self, noise: f64) -> f64 {
        if self.collapsed {
            return 0.0;
        }
        (self.possibilities.len() as f64).ln() + noise * 0.001
    }

    pub fn collapse(&mut self, state: TileState) {
        self.possibilities.clear();
        self.possibilities.insert(state.compact_key());
        self.collapsed = true;
        self.tile = Some(state);
    }
}

/// Pre-computed adjacency rules for fast constraint propagation.
/// Uses edge-based indexing: edge_type → direction → level → Set<compact_key>
pub struct AdjacencyRules {
    /// For each state: per direction, the edge type and level.
    pub state_edges: HashMap<u32, [(crate::tile::EdgeType, u8); 6]>,
    /// edge_type → direction → level → Set of compatible state keys
    by_edge: HashMap<crate::tile::EdgeType, Vec<HashMap<u8, HashSet<u32>>>>,
}

impl AdjacencyRules {
    /// Build adjacency rules from tile definitions and allowed tile types.
    pub fn build(tiles: &[TileDef], allowed_types: Option<&[u16]>) -> Self {
        let all_states = generate_all_states(tiles);
        let filtered: Vec<_> = match allowed_types {
            Some(types) => {
                let type_set: HashSet<u16> = types.iter().copied().collect();
                all_states
                    .into_iter()
                    .filter(|s| type_set.contains(&s.tile_id))
                    .collect()
            }
            None => all_states,
        };

        let mut state_edges: HashMap<u32, [(crate::tile::EdgeType, u8); 6]> = HashMap::new();
        let mut by_edge: HashMap<crate::tile::EdgeType, Vec<HashMap<u8, HashSet<u32>>>> =
            HashMap::new();

        for state in &filtered {
            let key = state.compact_key();
            let tile = &tiles[state.tile_id as usize];
            let mut edges = [(crate::tile::EdgeType::Grass, 0u8); 6];

            for dir in HexDir::ALL {
                let edge_type = get_edge_type(tile, state.rotation, dir);
                let edge_level = get_edge_level(tile, state.rotation, dir, state.level);
                edges[dir.index()] = (edge_type, edge_level);

                let dir_maps = by_edge.entry(edge_type).or_insert_with(|| {
                    (0..6).map(|_| HashMap::new()).collect()
                });
                dir_maps[dir.index()]
                    .entry(edge_level)
                    .or_default()
                    .insert(key);
            }

            state_edges.insert(key, edges);
        }

        Self {
            state_edges,
            by_edge,
        }
    }

    /// Get all states with the given edge type, direction, and level.
    pub fn get_by_edge(
        &self,
        edge_type: crate::tile::EdgeType,
        dir: HexDir,
        level: u8,
    ) -> Option<&HashSet<u32>> {
        self.by_edge
            .get(&edge_type)?
            .get(dir.index())?
            .get(&level)
    }

    /// Get all state compact keys.
    pub fn all_state_keys(&self) -> Vec<u32> {
        self.state_edges.keys().copied().collect()
    }
}

/// A hex grid for WFC with cells and adjacency rules.
pub struct WfcGrid {
    pub cells: HashMap<String, WfcCell>, // key = CubeCoord::key()
    pub rules: AdjacencyRules,
    tiles: Vec<TileDef>,
}

impl WfcGrid {
    /// Create a new WFC grid with the given cells.
    pub fn new(
        coords: &[CubeCoord],
        tiles: Vec<TileDef>,
        allowed_types: Option<&[u16]>,
    ) -> Self {
        let rules = AdjacencyRules::build(&tiles, allowed_types);
        let all_keys = rules.all_state_keys();
        let cells = coords
            .iter()
            .map(|&coord| (coord.key(), WfcCell::new(coord, &all_keys)))
            .collect();

        Self {
            cells,
            rules,
            tiles,
        }
    }

    /// Create a grid for a hex region of the given radius centered at origin.
    pub fn with_radius(radius: i32, allowed_types: Option<&[u16]>) -> Self {
        let tiles = build_tile_list();
        let coords = CubeCoord::new(0, 0).cells_in_radius(radius);
        Self::new(&coords, tiles, allowed_types)
    }

    /// Get the tile definitions.
    pub fn tiles(&self) -> &[TileDef] {
        &self.tiles
    }

    /// Fix a cell to a specific state (used for boundary constraints).
    pub fn fix_cell(&mut self, coord: &CubeCoord, state: TileState) {
        if let Some(cell) = self.cells.get_mut(&coord.key()) {
            cell.collapse(state);
        }
    }

    /// Check if a cell exists and is not collapsed.
    pub fn is_uncollapsed(&self, coord: &CubeCoord) -> bool {
        self.cells
            .get(&coord.key())
            .is_some_and(|c| !c.collapsed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grid_with_radius_8_has_217_cells() {
        let grid = WfcGrid::with_radius(8, None);
        assert_eq!(grid.cells.len(), 217);
    }

    #[test]
    fn all_cells_start_uncollapsed() {
        let grid = WfcGrid::with_radius(2, None);
        for cell in grid.cells.values() {
            assert!(!cell.collapsed);
            assert!(cell.possibilities.len() > 0);
        }
    }

    #[test]
    fn fix_cell_collapses_it() {
        let mut grid = WfcGrid::with_radius(2, None);
        let coord = CubeCoord::new(0, 0);
        let state = TileState {
            tile_id: 0,
            rotation: 0,
            level: 0,
        };
        grid.fix_cell(&coord, state);
        let cell = grid.cells.get(&coord.key()).unwrap();
        assert!(cell.collapsed);
        assert_eq!(cell.tile, Some(state));
    }

    #[test]
    fn adjacency_rules_have_states() {
        let tiles = build_tile_list();
        let rules = AdjacencyRules::build(&tiles, None);
        assert!(rules.all_state_keys().len() > 500);
    }

    #[test]
    fn by_edge_lookup_works() {
        let tiles = build_tile_list();
        let rules = AdjacencyRules::build(&tiles, None);
        // There should be grass states at level 0 in NE direction
        let grass_ne_0 = rules.get_by_edge(crate::tile::EdgeType::Grass, HexDir::NE, 0);
        assert!(grass_ne_0.is_some());
        assert!(grass_ne_0.unwrap().len() > 10);
    }
}
