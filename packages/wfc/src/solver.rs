use std::collections::HashSet;

use crate::grid::WfcGrid;
use crate::hex::HexDir;
use crate::rng::Rng;
use crate::tile::{EdgeType, TileState, LEVELS_COUNT};

/// A single entry in the backtracking trail.
/// Records a possibility that was removed during propagation.
#[derive(Clone, Debug)]
struct TrailEntry {
    coord_key: String,
    state_key: u32,
}

/// A decision point for backtracking.
#[derive(Clone, Debug)]
struct Decision {
    coord_key: String,
    prev_possibilities: HashSet<u32>,
    trail_start: usize,
    collapse_order_len: usize,
    tried_states: HashSet<u32>,
}

/// Result of a WFC solve attempt.
#[derive(Clone, Debug)]
pub struct SolveResult {
    pub success: bool,
    pub tiles: Vec<CollapsedTile>,
    pub collapse_order: Vec<CollapsedTile>,
    pub backtracks: u32,
}

/// A collapsed tile with its position and state.
#[derive(Clone, Debug)]
pub struct CollapsedTile {
    pub q: i32,
    pub r: i32,
    pub s: i32,
    pub tile_id: u16,
    pub rotation: u8,
    pub level: u8,
}

/// WFC solver with trail-based backtracking.
pub struct Solver {
    rng: Rng,
    max_backtracks: u32,
    trail: Vec<TrailEntry>,
    decisions: Vec<Decision>,
    collapse_order: Vec<CollapsedTile>,
    backtracks: u32,
}

impl Solver {
    pub fn new(seed: u64, max_backtracks: u32) -> Self {
        Self {
            rng: Rng::new(seed),
            max_backtracks,
            trail: Vec::new(),
            decisions: Vec::new(),
            collapse_order: Vec::new(),
            backtracks: 0,
        }
    }

    /// Solve a WFC grid. Returns the result.
    pub fn solve(&mut self, grid: &mut WfcGrid) -> SolveResult {
        self.trail.clear();
        self.decisions.clear();
        self.collapse_order.clear();
        self.backtracks = 0;

        if !self.initialize_fixed_constraints(grid) {
            return self.build_result(grid, false);
        }

        if grid.cells.values().any(|cell| cell.possibilities.is_empty()) {
            return self.build_result(grid, false);
        }

        loop {
            // Find the uncollapsed cell with lowest entropy
            let target = self.find_lowest_entropy(grid);
            let target = match target {
                Some(key) => key,
                None => {
                    // All cells collapsed - success!
                    return self.build_result(grid, true);
                }
            };

            // Get available states (excluding already-tried from backtracking)
            let tried = self
                .decisions
                .last()
                .filter(|d| d.coord_key == target)
                .map(|d| &d.tried_states);

            let cell = grid.cells.get(&target).unwrap();
            let mut available: Vec<u32> = cell
                .possibilities
                .iter()
                .filter(|k| tried.is_none_or(|t| !t.contains(k)))
                .copied()
                .collect();
            available.sort_unstable();

            if available.is_empty() {
                // Contradiction - try backtracking
                if !self.backtrack(grid) {
                    return self.build_result(grid, false);
                }
                continue;
            }

            // Record decision point
            let cell = grid.cells.get(&target).unwrap();
            let decision = Decision {
                coord_key: target.clone(),
                prev_possibilities: cell.possibilities.clone(),
                trail_start: self.trail.len(),
                collapse_order_len: self.collapse_order.len(),
                tried_states: HashSet::new(),
            };
            self.decisions.push(decision);

            // Weighted random collapse
            let chosen = self.choose_state(grid, &available);

            // Record the choice as tried
            if let Some(d) = self.decisions.last_mut() {
                d.tried_states.insert(chosen.compact_key());
            }

            // Collapse the cell
            let cell = grid.cells.get_mut(&target).unwrap();
            let coord = cell.coord;
            cell.collapse(chosen);

            self.collapse_order.push(CollapsedTile {
                q: coord.q,
                r: coord.r,
                s: coord.s,
                tile_id: chosen.tile_id,
                rotation: chosen.rotation,
                level: chosen.level,
            });

            let mut propagation_stack = vec![target.clone()];
            if grid.rules.prevents_chaining(chosen.tile_id)
                && !self.prune_chaining(
                    grid,
                    &target,
                    chosen.tile_id,
                    &mut propagation_stack,
                    true,
                )
            {
                if !self.backtrack(grid) {
                    return self.build_result(grid, false);
                }
                continue;
            }

            // Propagate constraints
            if !self.propagate(grid, &mut propagation_stack, true) {
                // Contradiction during propagation - backtrack
                if !self.backtrack(grid) {
                    return self.build_result(grid, false);
                }
            }
        }
    }

    /// Find the uncollapsed cell with the lowest entropy.
    /// Uses deterministic tie-breaking based on the canonical key order
    /// computed when the grid is created.
    fn find_lowest_entropy(&mut self, grid: &WfcGrid) -> Option<String> {
        let mut best_key: Option<&String> = None;
        let mut best_entropy = f64::INFINITY;

        for key in grid.ordered_keys() {
            let cell = &grid.cells[key];
            if cell.collapsed || cell.possibilities.is_empty() {
                continue;
            }

            let noise = self.rng.f64();
            let entropy = cell.entropy(noise);
            if entropy < best_entropy {
                best_entropy = entropy;
                best_key = Some(key);
            }
        }

        best_key.cloned()
    }

    /// Choose a state from available options using weighted random selection.
    fn choose_state(&mut self, grid: &WfcGrid, available: &[u32]) -> TileState {
        let weights: Vec<f64> = available
            .iter()
            .map(|&key| grid.rules.weight_for_state(key))
            .collect();

        let idx = self.rng.weighted_choice(&weights);
        compact_to_state(available[idx])
    }

    fn initialize_fixed_constraints(&mut self, grid: &mut WfcGrid) -> bool {
        if grid.fixed_cells.is_empty() {
            return true;
        }

        let mut fixed_keys = grid.fixed_cells.keys().cloned().collect::<Vec<_>>();
        fixed_keys.sort();

        let fixed_cells = fixed_keys
            .iter()
            .map(|key| {
                let state = grid
                    .fixed_cells
                    .get(key)
                    .copied()
                    .expect("fixed key missing from fixed_cells");
                (key.clone(), state)
            })
            .collect::<Vec<_>>();
        let mut propagation_stack = fixed_keys.into_iter().rev().collect::<Vec<_>>();

        for (key, state) in fixed_cells {
            if grid.rules.prevents_chaining(state.tile_id)
                && !self.prune_chaining(
                    grid,
                    &key,
                    state.tile_id,
                    &mut propagation_stack,
                    false,
                )
            {
                return false;
            }
        }

        self.propagate(grid, &mut propagation_stack, false)
    }

    fn prune_chaining(
        &mut self,
        grid: &mut WfcGrid,
        key: &str,
        tile_id: u16,
        propagation_stack: &mut Vec<String>,
        record_trail: bool,
    ) -> bool {
        let neighbor_keys = match grid.neighbors(key) {
            Some(neighbors) => neighbors.iter().map(|neighbor| neighbor.key.clone()).collect::<Vec<_>>(),
            None => return true,
        };

        for neighbor_key in neighbor_keys {
            let to_remove = match grid.cells.get(&neighbor_key) {
                Some(neighbor) if !neighbor.collapsed => neighbor
                    .possibilities
                    .iter()
                    .filter(|state_key| ((**state_key >> 16) as u16) == tile_id)
                    .copied()
                    .collect::<Vec<_>>(),
                _ => continue,
            };

            if to_remove.is_empty() {
                continue;
            }

            let neighbor_cell = grid.cells.get_mut(&neighbor_key).unwrap();
            for state_key in to_remove {
                if neighbor_cell.possibilities.remove(&state_key) && record_trail {
                    self.trail.push(TrailEntry {
                        coord_key: neighbor_key.clone(),
                        state_key,
                    });
                }
            }

            if neighbor_cell.possibilities.is_empty() {
                return false;
            }

            propagation_stack.push(neighbor_key);
        }

        true
    }

    /// Propagate constraints from the current stack to neighboring solve cells.
    /// Returns false if a contradiction is detected.
    fn propagate(
        &mut self,
        grid: &mut WfcGrid,
        propagation_stack: &mut Vec<String>,
        record_trail: bool,
    ) -> bool {
        while let Some(current_key) = propagation_stack.pop() {
            let fixed_state = grid.fixed_state(&current_key);
            let neighbors = match grid.neighbors(&current_key) {
                Some(neighbors) => neighbors
                    .iter()
                    .map(|neighbor| (neighbor.key.clone(), neighbor.dir, neighbor.return_dir))
                    .collect::<Vec<_>>(),
                None => continue,
            };

            for (neighbor_key, dir, return_dir) in neighbors {
                let mut valid_neighbor_states = HashSet::new();
                let mut looked_up = HashSet::new();

                if let Some(state) = fixed_state {
                    self.extend_valid_neighbors(
                        grid,
                        state.compact_key(),
                        dir,
                        return_dir,
                        &mut valid_neighbor_states,
                        &mut looked_up,
                    );
                } else {
                    let Some(current_cell) = grid.cells.get(&current_key) else {
                        continue;
                    };
                    for &state_key in &current_cell.possibilities {
                        self.extend_valid_neighbors(
                            grid,
                            state_key,
                            dir,
                            return_dir,
                            &mut valid_neighbor_states,
                            &mut looked_up,
                        );
                    }
                }

                let to_remove = match grid.cells.get(&neighbor_key) {
                    Some(neighbor) if !neighbor.collapsed => neighbor
                        .possibilities
                        .iter()
                        .filter(|state_key| !valid_neighbor_states.contains(state_key))
                        .copied()
                        .collect::<Vec<_>>(),
                    _ => continue,
                };

                if to_remove.is_empty() {
                    continue;
                }

                let mut collapsed_state = None;
                {
                    let neighbor_cell = grid.cells.get_mut(&neighbor_key).unwrap();
                    for state_key in to_remove {
                        if neighbor_cell.possibilities.remove(&state_key) && record_trail {
                            self.trail.push(TrailEntry {
                                coord_key: neighbor_key.clone(),
                                state_key,
                            });
                        }
                    }

                    if neighbor_cell.possibilities.is_empty() {
                        return false;
                    }

                    if !neighbor_cell.collapsed && neighbor_cell.possibilities.len() == 1 {
                        let &only_key = neighbor_cell.possibilities.iter().next().unwrap();
                        let state = compact_to_state(only_key);
                        let coord = neighbor_cell.coord;
                        neighbor_cell.collapse(state);
                        collapsed_state = Some((coord, state));
                    }
                }

                if let Some((coord, state)) = collapsed_state {
                    self.collapse_order.push(CollapsedTile {
                        q: coord.q,
                        r: coord.r,
                        s: coord.s,
                        tile_id: state.tile_id,
                        rotation: state.rotation,
                        level: state.level,
                    });

                    if grid.rules.prevents_chaining(state.tile_id)
                        && !self.prune_chaining(
                            grid,
                            &neighbor_key,
                            state.tile_id,
                            propagation_stack,
                            record_trail,
                        )
                    {
                        return false;
                    }
                }

                propagation_stack.push(neighbor_key);
            }
        }

        true
    }

    fn extend_valid_neighbors(
        &self,
        grid: &WfcGrid,
        state_key: u32,
        dir: HexDir,
        return_dir: HexDir,
        valid_neighbors: &mut HashSet<u32>,
        looked_up: &mut HashSet<(EdgeType, u8)>,
    ) {
        let (edge_type, edge_level) = grid.rules.state_edges[&state_key][dir.index()];

        if edge_type == EdgeType::Grass {
            for level in 0..LEVELS_COUNT {
                if !looked_up.insert((edge_type, level)) {
                    continue;
                }
                if let Some(matching) = grid.rules.get_by_edge(edge_type, return_dir, level) {
                    valid_neighbors.extend(matching.iter().copied());
                }
            }
            return;
        }

        if !looked_up.insert((edge_type, edge_level)) {
            return;
        }

        if let Some(matching) = grid.rules.get_by_edge(edge_type, return_dir, edge_level) {
            valid_neighbors.extend(matching.iter().copied());
        }
    }

    /// Backtrack by undoing the last decision.
    /// Returns false if no more decisions to undo (max backtracks exceeded or empty).
    fn backtrack(&mut self, grid: &mut WfcGrid) -> bool {
        self.backtracks += 1;
        if self.backtracks > self.max_backtracks {
            return false;
        }

        let decision = match self.decisions.pop() {
            Some(d) => d,
            None => return false,
        };

        // Undo trail entries
        while self.trail.len() > decision.trail_start {
            let entry = self.trail.pop().unwrap();
            if let Some(cell) = grid.cells.get_mut(&entry.coord_key) {
                cell.possibilities.insert(entry.state_key);
                if cell.collapsed {
                    cell.collapsed = false;
                    cell.tile = None;
                }
            }
        }

        // Restore the decision cell
        let prev = decision.prev_possibilities.clone();
        if let Some(cell) = grid.cells.get_mut(&decision.coord_key) {
            cell.possibilities = prev;
            cell.collapsed = false;
            cell.tile = None;
        }

        // Trim collapse order
        self.collapse_order.truncate(decision.collapse_order_len);

        // Re-push with tried states so we try a different option
        self.decisions.push(decision);

        true
    }

    fn build_result(&self, grid: &WfcGrid, success: bool) -> SolveResult {
        let tiles: Vec<CollapsedTile> = grid
            .cells
            .values()
            .filter_map(|cell| {
                cell.tile.map(|state| CollapsedTile {
                    q: cell.coord.q,
                    r: cell.coord.r,
                    s: cell.coord.s,
                    tile_id: state.tile_id,
                    rotation: state.rotation,
                    level: state.level,
                })
            })
            .collect();

        SolveResult {
            success,
            tiles,
            collapse_order: self.collapse_order.clone(),
            backtracks: self.backtracks,
        }
    }
}

/// Convert a compact key back to a TileState.
fn compact_to_state(key: u32) -> TileState {
    TileState {
        tile_id: (key >> 16) as u16,
        rotation: ((key >> 8) & 0xFF) as u8,
        level: (key & 0xFF) as u8,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::grid::WfcGrid;
    use crate::hex::CubeCoord;
    use crate::tile::{build_tile_list, edges_compatible, WATER_TILE_ID};
    use std::collections::HashMap;

    fn sorted_tiles(tiles: &[CollapsedTile]) -> Vec<(i32, i32, u16, u8, u8)> {
        let mut sorted = tiles
            .iter()
            .map(|tile| {
                (
                    tile.q,
                    tile.r,
                    tile.tile_id,
                    tile.rotation,
                    tile.level,
                )
            })
            .collect::<Vec<_>>();
        sorted.sort();
        sorted
    }

    fn tile_id_by_name(name: &str) -> u16 {
        build_tile_list()
            .into_iter()
            .find(|tile| tile.name == name)
            .map(|tile| tile.id)
            .unwrap()
    }

    fn same_tile_can_match_across_direction(tile_id: u16, dir: HexDir) -> bool {
        let tiles = build_tile_list();
        let tile = &tiles[tile_id as usize];

        for left_rotation in 0..6u8 {
            for right_rotation in 0..6u8 {
                let left_edge = crate::tile::get_edge_type(tile, left_rotation, dir);
                let left_level = crate::tile::get_edge_level(tile, left_rotation, dir, 0);
                let right_edge = crate::tile::get_edge_type(tile, right_rotation, dir.opposite());
                let right_level =
                    crate::tile::get_edge_level(tile, right_rotation, dir.opposite(), 0);

                if edges_compatible(left_edge, left_level, right_edge, right_level) {
                    return true;
                }
            }
        }

        false
    }

    #[test]
    fn compact_key_roundtrip() {
        let state = TileState {
            tile_id: 15,
            rotation: 3,
            level: 2,
        };
        let key = state.compact_key();
        let back = compact_to_state(key);
        assert_eq!(back, state);
    }

    #[test]
    fn solve_small_grid_succeeds() {
        let mut grid = WfcGrid::with_radius(2, None);
        let mut solver = Solver::new(42, 500);
        let result = solver.solve(&mut grid);
        assert!(
            result.success,
            "failed to solve radius-2 grid (backtracks: {})",
            result.backtracks
        );
        // 19 cells in radius-2 grid
        assert_eq!(result.tiles.len(), 19);
    }

    #[test]
    fn solve_medium_grid_succeeds() {
        let mut grid = WfcGrid::with_radius(4, None);
        let mut solver = Solver::new(42, 500);
        let result = solver.solve(&mut grid);
        assert!(
            result.success,
            "failed to solve radius-4 grid (backtracks: {})",
            result.backtracks
        );
    }

    #[test]
    fn solve_full_grid_succeeds() {
        let mut grid = WfcGrid::with_radius(8, None);
        let mut solver = Solver::new(42, 500);
        let result = solver.solve(&mut grid);
        assert!(
            result.success,
            "failed to solve radius-8 grid (backtracks: {})",
            result.backtracks
        );
        assert_eq!(result.tiles.len(), 217);
    }

    #[test]
    fn multiple_solves_all_succeed() {
        // Verify that the solver consistently produces valid results
        for seed in 0..5u64 {
            let mut grid = WfcGrid::with_radius(4, None);
            let mut solver = Solver::new(seed, 500);
            let result = solver.solve(&mut grid);
            assert!(
                result.success,
                "seed {seed} failed (backtracks: {})",
                result.backtracks
            );
            assert_eq!(result.tiles.len(), 61, "seed {seed} wrong tile count");
        }
    }

    #[test]
    fn collapse_order_recorded() {
        let mut grid = WfcGrid::with_radius(2, None);
        let mut solver = Solver::new(42, 500);
        let result = solver.solve(&mut grid);
        assert!(result.success);
        assert!(!result.collapse_order.is_empty());
    }

    #[test]
    fn adjacent_tiles_compatible() {
        let mut grid = WfcGrid::with_radius(4, None);
        let mut solver = Solver::new(42, 500);
        let result = solver.solve(&mut grid);
        assert!(result.success);

        let tiles = crate::tile::build_tile_list();
        let tile_map: HashMap<String, &CollapsedTile> = result
            .tiles
            .iter()
            .map(|t| {
                let coord = CubeCoord::new(t.q, t.r);
                (coord.key(), t)
            })
            .collect();

        for t in &result.tiles {
            let coord = CubeCoord::new(t.q, t.r);
            let tile_def = &tiles[t.tile_id as usize];

            for dir in HexDir::ALL {
                let neighbor_coord = coord.neighbor(dir);
                if let Some(neighbor) = tile_map.get(&neighbor_coord.key()) {
                    let neighbor_def = &tiles[neighbor.tile_id as usize];

                    let edge_type = crate::tile::get_edge_type(tile_def, t.rotation, dir);
                    let edge_level =
                        crate::tile::get_edge_level(tile_def, t.rotation, dir, t.level);

                    let n_edge_type = crate::tile::get_edge_type(
                        neighbor_def,
                        neighbor.rotation,
                        dir.opposite(),
                    );
                    let n_edge_level = crate::tile::get_edge_level(
                        neighbor_def,
                        neighbor.rotation,
                        dir.opposite(),
                        neighbor.level,
                    );

                    assert!(
                        edges_compatible(edge_type, edge_level, n_edge_type, n_edge_level),
                        "incompatible edges at ({},{}) {:?}: {:?}@{} vs {:?}@{}",
                        t.q,
                        t.r,
                        dir,
                        edge_type,
                        edge_level,
                        n_edge_type,
                        n_edge_level
                    );
                }
            }
        }
    }

    #[test]
    fn fixed_cells_apply_boundary_constraints() {
        let coords = [CubeCoord::new(0, 0)];
        let fixed = [(
            CubeCoord::new(1, 0),
            TileState {
                tile_id: WATER_TILE_ID,
                rotation: 0,
                level: 0,
            },
        )];
        let mut grid = WfcGrid::new(&coords, &fixed, Some(&[0]));
        let mut solver = Solver::new(42, 500);
        let result = solver.solve(&mut grid);

        assert!(!result.success, "grass-only solve should conflict with fixed water edge");
    }

    #[test]
    fn fixed_constraint_order_is_deterministic() {
        let road_d_id = tile_id_by_name("ROAD_D");
        let coords = [CubeCoord::new(0, 0), CubeCoord::new(1, -1), CubeCoord::new(-1, 1)];
        let fixed = [
            (
                CubeCoord::new(1, 0),
                TileState {
                    tile_id: road_d_id,
                    rotation: 0,
                    level: 0,
                },
            ),
            (
                CubeCoord::new(-1, 0),
                TileState {
                    tile_id: road_d_id,
                    rotation: 3,
                    level: 0,
                },
            ),
        ];

        let mut grid_a = WfcGrid::new(&coords, &fixed, None);
        let mut grid_b = WfcGrid::new(&coords, &fixed, None);
        let mut solver_a = Solver::new(42, 500);
        let mut solver_b = Solver::new(42, 500);
        let result_a = solver_a.solve(&mut grid_a);
        let result_b = solver_b.solve(&mut grid_b);

        assert_eq!(result_a.success, result_b.success);
        assert_eq!(sorted_tiles(&result_a.tiles), sorted_tiles(&result_b.tiles));
        assert_eq!(
            sorted_tiles(&result_a.collapse_order),
            sorted_tiles(&result_b.collapse_order),
        );
    }

    #[test]
    fn prevent_chaining_applies_to_fixed_neighbors() {
        let road_d_id = tile_id_by_name("ROAD_D");
        assert!(same_tile_can_match_across_direction(road_d_id, HexDir::E));

        let coords = [CubeCoord::new(0, 0)];
        let fixed = [(
            CubeCoord::new(1, 0),
            TileState {
                tile_id: road_d_id,
                rotation: 0,
                level: 0,
            },
        )];
        let mut grid = WfcGrid::new(&coords, &fixed, Some(&[road_d_id]));
        let mut solver = Solver::new(42, 500);
        let result = solver.solve(&mut grid);

        assert!(
            !result.success,
            "fixed prevent-chaining tile should remove matching tile candidates from neighbors",
        );
    }

    #[test]
    fn prevent_chaining_applies_after_collapse() {
        let road_d_id = tile_id_by_name("ROAD_D");
        assert!(same_tile_can_match_across_direction(road_d_id, HexDir::E));

        let coords = [CubeCoord::new(0, 0), CubeCoord::new(1, 0)];
        let mut grid = WfcGrid::new(&coords, &[], Some(&[road_d_id]));
        let mut solver = Solver::new(42, 500);
        let result = solver.solve(&mut grid);

        assert!(
            !result.success,
            "adjacent prevent-chaining tiles should be rejected once one cell collapses",
        );
    }

    #[test]
    fn canonical_order_is_independent_of_input_order() {
        let coords = CubeCoord::new(0, 0).cells_in_radius(2);
        let mut reversed = coords.clone();
        reversed.reverse();

        let mut grid_a = WfcGrid::new(&coords, &[], None);
        let mut grid_b = WfcGrid::new(&reversed, &[], None);
        let mut solver_a = Solver::new(42, 500);
        let mut solver_b = Solver::new(42, 500);
        let result_a = solver_a.solve(&mut grid_a);
        let result_b = solver_b.solve(&mut grid_b);

        assert!(result_a.success);
        assert!(result_b.success);
        assert_eq!(sorted_tiles(&result_a.tiles), sorted_tiles(&result_b.tiles));
        assert_eq!(
            sorted_tiles(&result_a.collapse_order),
            sorted_tiles(&result_b.collapse_order),
        );
    }
}
