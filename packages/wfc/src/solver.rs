use std::collections::{HashSet, VecDeque};

use crate::grid::WfcGrid;
use crate::hex::HexDir;
use crate::rng::Rng;
use crate::tile::TileState;

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
            let available: Vec<u32> = cell
                .possibilities
                .iter()
                .filter(|k| tried.is_none_or(|t| !t.contains(k)))
                .copied()
                .collect();

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

            // Propagate constraints
            if !self.propagate(grid, &target) {
                // Contradiction during propagation - backtrack
                if !self.backtrack(grid) {
                    return self.build_result(grid, false);
                }
            }
        }
    }

    /// Find the uncollapsed cell with the lowest entropy.
    /// Uses deterministic tie-breaking by sorting keys to ensure
    /// same-seed reproducibility regardless of HashMap iteration order.
    fn find_lowest_entropy(&mut self, grid: &WfcGrid) -> Option<String> {
        // Collect uncollapsed cells with their noise values
        let mut candidates: Vec<(&String, f64)> = Vec::new();

        // Sort keys for deterministic iteration
        let mut keys: Vec<&String> = grid.cells.keys().collect();
        keys.sort();

        for key in keys {
            let cell = &grid.cells[key];
            if cell.collapsed || cell.possibilities.is_empty() {
                continue;
            }
            let noise = self.rng.f64();
            let entropy = cell.entropy(noise);
            candidates.push((key, entropy));
        }

        candidates
            .into_iter()
            .min_by(|a, b| a.1.partial_cmp(&b.1).unwrap())
            .map(|(key, _)| key.clone())
    }

    /// Choose a state from available options using weighted random selection.
    fn choose_state(&mut self, grid: &WfcGrid, available: &[u32]) -> TileState {
        let tiles = grid.tiles();
        let weights: Vec<f64> = available
            .iter()
            .map(|&key| {
                let state = compact_to_state(key);
                tiles[state.tile_id as usize].weight
            })
            .collect();

        let idx = self.rng.weighted_choice(&weights);
        compact_to_state(available[idx])
    }

    /// Propagate constraints from a collapsed cell to its neighbors.
    /// Returns false if a contradiction is detected.
    fn propagate(&mut self, grid: &mut WfcGrid, start_key: &str) -> bool {
        let mut queue: VecDeque<String> = VecDeque::new();
        queue.push_back(start_key.to_string());

        while let Some(current_key) = queue.pop_front() {
            let current_cell = match grid.cells.get(&current_key) {
                Some(c) => c,
                None => continue,
            };
            let coord = current_cell.coord;

            for dir in HexDir::ALL {
                let neighbor_coord = coord.neighbor(dir);
                let neighbor_key = neighbor_coord.key();

                let neighbor = match grid.cells.get(&neighbor_key) {
                    Some(n) if !n.collapsed => n,
                    _ => continue,
                };

                // Compute which neighbor states are still valid
                let valid_neighbor_states = self.compute_valid_neighbors(grid, &current_key, dir);

                // Remove invalid states from neighbor
                let to_remove: Vec<u32> = neighbor
                    .possibilities
                    .iter()
                    .filter(|k| !valid_neighbor_states.contains(k))
                    .copied()
                    .collect();

                if to_remove.is_empty() {
                    continue;
                }

                let neighbor_cell = grid.cells.get_mut(&neighbor_key).unwrap();
                for &key in &to_remove {
                    if neighbor_cell.possibilities.remove(&key) {
                        self.trail.push(TrailEntry {
                            coord_key: neighbor_key.clone(),
                            state_key: key,
                        });
                    }
                }

                if neighbor_cell.possibilities.is_empty() {
                    return false; // Contradiction
                }

                // If only one possibility left, auto-collapse
                if neighbor_cell.possibilities.len() == 1 {
                    let &only_key = neighbor_cell.possibilities.iter().next().unwrap();
                    let state = compact_to_state(only_key);
                    let coord = neighbor_cell.coord;
                    neighbor_cell.collapse(state);
                    self.collapse_order.push(CollapsedTile {
                        q: coord.q,
                        r: coord.r,
                        s: coord.s,
                        tile_id: state.tile_id,
                        rotation: state.rotation,
                        level: state.level,
                    });
                }

                queue.push_back(neighbor_key);
            }
        }

        true
    }

    /// Compute which neighbor states are valid given the current cell's state(s).
    fn compute_valid_neighbors(
        &self,
        grid: &WfcGrid,
        cell_key: &str,
        dir: HexDir,
    ) -> HashSet<u32> {
        let cell = &grid.cells[cell_key];
        let opp_dir = dir.opposite();
        let mut valid = HashSet::new();

        for &state_key in &cell.possibilities {
            let (edge_type, edge_level) = grid.rules.state_edges[&state_key][dir.index()];

            // Find neighbor states that have matching edge on opposite side
            if let Some(matching) = grid.rules.get_by_edge(edge_type, opp_dir, edge_level) {
                valid.extend(matching);
            }

            // Grass wildcard: any level matches
            if edge_type == crate::tile::EdgeType::Grass {
                for level in 0..crate::tile::LEVELS_COUNT {
                    if let Some(matching) =
                        grid.rules.get_by_edge(edge_type, opp_dir, level)
                    {
                        valid.extend(matching);
                    }
                }
            }
        }

        valid
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
    use crate::tile::edges_compatible;
    use std::collections::HashMap;

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
}
