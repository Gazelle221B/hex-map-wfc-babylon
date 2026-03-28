use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};

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

#[derive(Clone, Debug)]
pub struct NeighborRef {
    pub key: String,
    pub dir: HexDir,
    pub return_dir: HexDir,
}

/// Pre-computed adjacency rules for fast constraint propagation.
/// Uses edge-based indexing: edge_type → direction → level → Set<compact_key>
pub struct AdjacencyRules {
    /// For each state: per direction, the edge type and level.
    pub state_edges: HashMap<u32, [(crate::tile::EdgeType, u8); 6]>,
    /// edge_type → direction → level → Set of compatible state keys
    by_edge: HashMap<crate::tile::EdgeType, Vec<HashMap<u8, HashSet<u32>>>>,
    all_state_keys: Vec<u32>,
    state_weights: HashMap<u32, f64>,
    no_chain_types: HashSet<u16>,
}

impl AdjacencyRules {
    /// Build adjacency rules from tile definitions and allowed tile types.
    pub fn build(tiles: &[TileDef], allowed_types: Option<&[u16]>) -> Self {
        let all_states = generate_all_states(tiles);
        let allowed_type_set = allowed_types.map(|types| types.iter().copied().collect::<HashSet<_>>());

        let mut state_edges: HashMap<u32, [(crate::tile::EdgeType, u8); 6]> =
            HashMap::with_capacity(all_states.len());
        let mut by_edge: HashMap<crate::tile::EdgeType, Vec<HashMap<u8, HashSet<u32>>>> =
            HashMap::new();
        let mut all_state_keys = Vec::new();
        let mut state_weights = HashMap::with_capacity(all_states.len());
        let mut no_chain_types = HashSet::new();

        for state in &all_states {
            let key = state.compact_key();
            let tile = &tiles[state.tile_id as usize];
            let mut edges = [(crate::tile::EdgeType::Grass, 0u8); 6];

            if allowed_type_set
                .as_ref()
                .is_none_or(|type_set| type_set.contains(&state.tile_id))
            {
                all_state_keys.push(key);
            }
            state_weights.insert(key, tile.weight);
            if tile.prevent_chaining {
                no_chain_types.insert(tile.id);
            }

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
            all_state_keys,
            state_weights,
            no_chain_types,
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

    pub fn all_state_keys(&self) -> &[u32] {
        &self.all_state_keys
    }

    pub fn weight_for_state(&self, state_key: u32) -> f64 {
        self.state_weights.get(&state_key).copied().unwrap_or(1.0)
    }

    pub fn prevents_chaining(&self, tile_id: u16) -> bool {
        self.no_chain_types.contains(&tile_id)
    }
}

type RulesCacheKey = Option<Vec<u16>>;

static SHARED_TILE_DEFS: OnceLock<Vec<TileDef>> = OnceLock::new();
static RULES_CACHE: OnceLock<Mutex<HashMap<RulesCacheKey, Arc<AdjacencyRules>>>> = OnceLock::new();

fn shared_tile_defs() -> &'static [TileDef] {
    SHARED_TILE_DEFS.get_or_init(build_tile_list).as_slice()
}

fn canonical_allowed_types(allowed_types: Option<&[u16]>) -> RulesCacheKey {
    allowed_types.map(|types| {
        let mut canonical = types.to_vec();
        canonical.sort_unstable();
        canonical.dedup();
        canonical
    })
}

fn shared_rules(allowed_types: Option<&[u16]>) -> Arc<AdjacencyRules> {
    let key = canonical_allowed_types(allowed_types);
    let cache = RULES_CACHE.get_or_init(|| Mutex::new(HashMap::new()));

    let mut rules = cache.lock().expect("rules cache lock poisoned");
    if let Some(existing) = rules.get(&key) {
        return existing.clone();
    }

    let build_key = key.clone();
    let created = Arc::new(AdjacencyRules::build(
        shared_tile_defs(),
        build_key.as_deref(),
    ));
    rules.insert(key, created.clone());
    created
}

/// A hex grid for WFC with cells and adjacency rules.
pub struct WfcGrid {
    pub cells: HashMap<String, WfcCell>, // key = CubeCoord::key()
    pub fixed_cells: HashMap<String, TileState>,
    pub rules: Arc<AdjacencyRules>,
    ordered_keys: Vec<String>,
    neighbors: HashMap<String, Vec<NeighborRef>>,
}

impl WfcGrid {
    /// Create a new WFC grid with the given cells.
    pub fn new(
        coords: &[CubeCoord],
        fixed_cells: &[(CubeCoord, TileState)],
        allowed_types: Option<&[u16]>,
    ) -> Self {
        let rules = shared_rules(allowed_types);
        let fixed_cell_entries = fixed_cells
            .iter()
            .map(|(coord, state)| (*coord, coord.key(), *state))
            .collect::<Vec<_>>();
        let cells = coords
            .iter()
            .map(|&coord| (coord.key(), WfcCell::new(coord, rules.all_state_keys())))
            .collect::<HashMap<_, _>>();

        let fixed_cells = fixed_cell_entries
            .iter()
            .map(|(_, key, state)| (key.clone(), *state))
            .collect::<HashMap<_, _>>();

        let mut ordered_keys = cells.keys().cloned().collect::<Vec<_>>();
        ordered_keys.sort();

        let mut neighbors = HashMap::new();
        for coord in coords {
            let key = coord.key();
            let mut links = Vec::new();

            for dir in HexDir::ALL {
                let neighbor_key = coord.neighbor(dir).key();
                if cells.contains_key(&neighbor_key) || fixed_cells.contains_key(&neighbor_key) {
                    links.push(NeighborRef {
                        key: neighbor_key,
                        dir,
                        return_dir: dir.opposite(),
                    });
                }
            }

            neighbors.insert(key, links);
        }

        for (coord, key, _) in &fixed_cell_entries {
            let mut links = Vec::new();

            for dir in HexDir::ALL {
                let neighbor_key = coord.neighbor(dir).key();
                if cells.contains_key(&neighbor_key) {
                    links.push(NeighborRef {
                        key: neighbor_key,
                        dir,
                        return_dir: dir.opposite(),
                    });
                }
            }

            if !links.is_empty() {
                neighbors.insert(key.clone(), links);
            }
        }

        Self {
            cells,
            fixed_cells,
            rules,
            ordered_keys,
            neighbors,
        }
    }

    /// Create a grid for a hex region of the given radius centered at origin.
    pub fn with_radius(radius: i32, allowed_types: Option<&[u16]>) -> Self {
        let coords = CubeCoord::new(0, 0).cells_in_radius(radius);
        Self::new(&coords, &[], allowed_types)
    }

    pub fn ordered_keys(&self) -> &[String] {
        &self.ordered_keys
    }

    pub fn neighbors(&self, key: &str) -> Option<&[NeighborRef]> {
        self.neighbors.get(key).map(Vec::as_slice)
    }

    pub fn fixed_state(&self, key: &str) -> Option<TileState> {
        self.fixed_cells.get(key).copied()
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
        let rules = shared_rules(None);
        assert!(rules.all_state_keys().len() > 500);
    }

    #[test]
    fn by_edge_lookup_works() {
        let rules = shared_rules(None);
        // There should be grass states at level 0 in NE direction
        let grass_ne_0 = rules.get_by_edge(crate::tile::EdgeType::Grass, HexDir::NE, 0);
        assert!(grass_ne_0.is_some());
        assert!(grass_ne_0.unwrap().len() > 10);
    }

    #[test]
    fn grid_order_is_canonical_for_reversed_input() {
        let mut coords = CubeCoord::new(0, 0).cells_in_radius(2);
        let expected = {
            let mut keys = coords.iter().map(CubeCoord::key).collect::<Vec<_>>();
            keys.sort();
            keys
        };

        coords.reverse();
        let grid = WfcGrid::new(&coords, &[], None);
        assert_eq!(grid.ordered_keys(), expected);
    }
}
