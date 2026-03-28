use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use crate::grid::WfcGrid;
use crate::hex::CubeCoord;
use crate::solver::{CollapsedTile, SolveResult, Solver};
use crate::tile::{TileState, WATER_TILE_ID};

/// Grid-level radius for the hex-of-hex (19 grids at radius 2).
pub const GRID_RADIUS: i32 = 2;

/// Tile-level radius for each individual hex grid.
pub const TILE_RADIUS: i32 = 8;

/// Maximum backtracks per solve attempt.
pub const MAX_BACKTRACKS: u32 = 500;

/// Maximum retries per solve attempt (Layer 0).
pub const MAX_TRIES: u32 = 2;

/// Maximum local-WFC attempts (Layer 1).
pub const MAX_LOCAL_ATTEMPTS: u32 = 5;

/// Radius for local WFC re-solve regions.
pub const LOCAL_SOLVE_RADIUS: i32 = 2;

/// A solved cell stored in the global cell map.
#[derive(Clone, Debug)]
pub struct GlobalCell {
    pub coord: CubeCoord,
    pub tile_id: u16,
    pub rotation: u8,
    pub level: u8,
    pub grid_key: String,
}

impl GlobalCell {
    pub fn to_tile_state(&self) -> TileState {
        TileState {
            tile_id: self.tile_id,
            rotation: self.rotation,
            level: self.level,
        }
    }
}

/// Statistics from a multi-grid solve operation.
#[derive(Clone, Debug, Default)]
pub struct SolveStats {
    pub backtracks: u32,
    pub tries: u32,
    pub local_wfc_attempts: u32,
    pub dropped_count: u32,
}

/// Result of solving a single grid within the multi-grid system.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GridSolveStatus {
    Solved,
    FallbackWater,
}

impl GridSolveStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            GridSolveStatus::Solved => "solved",
            GridSolveStatus::FallbackWater => "fallback_water",
        }
    }
}

#[derive(Clone, Debug)]
pub struct GridSolveResult {
    pub status: GridSolveStatus,
    pub success: bool,
    pub tiles: Vec<CollapsedTile>,
    pub collapse_order: Vec<CollapsedTile>,
    pub changed_fixed_cells: Vec<CollapsedTile>,
    pub dropped_cubes: Vec<CubeCoord>,
    pub stats: SolveStats,
}

/// Global cell map shared across all 19 grids.
pub struct GlobalCellMap {
    cells: HashMap<String, GlobalCell>,
}

impl GlobalCellMap {
    pub fn new() -> Self {
        Self {
            cells: HashMap::new(),
        }
    }

    pub fn get(&self, key: &str) -> Option<&GlobalCell> {
        self.cells.get(key)
    }

    pub fn contains(&self, key: &str) -> bool {
        self.cells.contains_key(key)
    }

    /// Insert or update a cell.
    pub fn insert(&mut self, cell: GlobalCell) {
        let key = cell.coord.key();
        self.cells.insert(key, cell);
    }

    /// Insert all tiles from a solve result into the global map.
    pub fn insert_result(&mut self, tiles: &[CollapsedTile], grid_key: &str) {
        for t in tiles {
            self.insert(GlobalCell {
                coord: CubeCoord::new(t.q, t.r),
                tile_id: t.tile_id,
                rotation: t.rotation,
                level: t.level,
                grid_key: grid_key.to_string(),
            });
        }
    }

    /// Remove cells belonging to a specific grid.
    pub fn remove_grid(&mut self, grid_key: &str) {
        self.cells.retain(|_, cell| cell.grid_key != grid_key);
    }

    pub fn len(&self) -> usize {
        self.cells.len()
    }

    pub fn is_empty(&self) -> bool {
        self.cells.is_empty()
    }
}

/// Compute the center of a grid in tile-cube space.
/// Grid positions are cube coordinates in the hex-of-hex.
/// tile_center = grid_cube * (2 * tile_radius + 1)
pub fn grid_center(grid_pos: CubeCoord, tile_radius: i32) -> CubeCoord {
    let scale = 2 * tile_radius + 1;
    CubeCoord::new(grid_pos.q * scale, grid_pos.r * scale)
}

/// Convert local tile cube coord to global cube coord.
pub fn local_to_global(local: CubeCoord, center: CubeCoord) -> CubeCoord {
    CubeCoord::new(local.q + center.q, local.r + center.r)
}

/// Convert global cube coord to local tile cube coord.
pub fn global_to_local(global: CubeCoord, center: CubeCoord) -> CubeCoord {
    CubeCoord::new(global.q - center.q, global.r - center.r)
}

/// Enumerate all 19 grid positions in the hex-of-hex (radius 2).
pub fn all_grid_positions() -> Vec<CubeCoord> {
    // This explicit order is the cross-language gridIndex <-> (q, r, s) contract
    // shared with packages/wfc/ts/grid-positions.ts and used by placements.
    let mut positions = CubeCoord::new(0, 0).cells_in_radius(GRID_RADIUS);
    positions.sort_by(compare_grid_positions);
    positions
}

fn compare_grid_positions(a: &CubeCoord, b: &CubeCoord) -> Ordering {
    a.distance(&CubeCoord::new(0, 0))
        .cmp(&b.distance(&CubeCoord::new(0, 0)))
        .then_with(|| a.q.cmp(&b.q))
        .then_with(|| a.r.cmp(&b.r))
        .then_with(|| a.s.cmp(&b.s))
}

/// Get fixed cells (boundary constraints) for a grid solve.
/// Returns cells from `global_map` that are adjacent to `solve_coords`
/// but not in the solve set themselves.
pub fn get_fixed_cells(
    solve_coords: &HashSet<String>,
    global_map: &GlobalCellMap,
) -> Vec<(CubeCoord, TileState)> {
    let mut fixed = Vec::new();
    let mut seen = HashSet::new();

    for key in solve_coords {
        // Parse the coord from key
        let coord = match parse_cube_key(key) {
            Some(c) => c,
            None => continue,
        };

        for neighbor in coord.neighbors() {
            let nkey = neighbor.key();
            if solve_coords.contains(&nkey) {
                continue;
            }
            if seen.contains(&nkey) {
                continue;
            }
            if let Some(global_cell) = global_map.get(&nkey) {
                fixed.push((neighbor, global_cell.to_tile_state()));
                seen.insert(nkey);
            }
        }
    }

    fixed
}

/// Parse a cube key string "q,r,s" back to CubeCoord.
fn parse_cube_key(key: &str) -> Option<CubeCoord> {
    let parts: Vec<&str> = key.split(',').collect();
    if parts.len() != 3 {
        return None;
    }
    let q: i32 = parts[0].parse().ok()?;
    let r: i32 = parts[1].parse().ok()?;
    Some(CubeCoord::new(q, r))
}

/// Solve a single grid with boundary constraints and recovery.
pub fn solve_grid(
    grid_pos: CubeCoord,
    global_map: &GlobalCellMap,
    seed: u64,
    allowed_types: Option<&[u16]>,
) -> GridSolveResult {
    let center = grid_center(grid_pos, TILE_RADIUS);
    let _grid_key = grid_pos.key();

    // Generate local coords for this grid
    let local_coords = CubeCoord::new(0, 0).cells_in_radius(TILE_RADIUS);

    // Map to global coords
    let global_coords: Vec<CubeCoord> = local_coords
        .iter()
        .map(|&c| local_to_global(c, center))
        .collect();
    let solve_set: HashSet<String> = global_coords.iter().map(|c| c.key()).collect();

    // Get boundary constraints
    let fixed_cells = get_fixed_cells(&solve_set, global_map);

    // Try solving with recovery cascade
    let mut stats = SolveStats::default();
    let mut dropped_cubes = Vec::new();
    let mut changed_fixed = Vec::new();

    // Layer 0: Direct solve with retries
    for try_idx in 0..MAX_TRIES {
        let result = attempt_solve(
            &global_coords,
            &fixed_cells,
            &dropped_cubes,
            seed + try_idx as u64,
            allowed_types,
        );
        stats.tries += 1;
        stats.backtracks += result.backtracks;

        if result.success {
            return build_grid_result(result, changed_fixed, dropped_cubes, stats);
        }
    }

    // Layer 1: Local WFC re-solve around conflict areas
    let mut active_fixed: Vec<(CubeCoord, TileState)> = fixed_cells.clone();
    for local_attempt in 0..MAX_LOCAL_ATTEMPTS {
        stats.local_wfc_attempts += 1;

        // Find a conflict center (nearest fixed cell to unsolved area)
        let conflict_center = find_conflict_center(&active_fixed, center);
        let conflict_center = match conflict_center {
            Some(c) => c,
            None => break,
        };

        // Re-solve a small region around the conflict
        let local_region: Vec<CubeCoord> = conflict_center
            .cells_in_radius(LOCAL_SOLVE_RADIUS)
            .into_iter()
            .filter(|c| global_map.contains(&c.key()))
            .collect();

        if local_region.is_empty() {
            continue;
        }

        let local_solve_set: HashSet<String> = local_region.iter().map(|c| c.key()).collect();
        let local_fixed = get_fixed_cells(&local_solve_set, global_map);

        let local_result = attempt_solve(
            &local_region,
            &local_fixed,
            &[],
            seed + 1000 + local_attempt as u64,
            allowed_types,
        );
        stats.backtracks += local_result.backtracks;
        stats.tries += 1;

        if !local_result.success {
            continue;
        }

        // Apply local result to active fixed cells
        let local_tile_map: HashMap<String, &CollapsedTile> = local_result
            .tiles
            .iter()
            .map(|t| (CubeCoord::new(t.q, t.r).key(), t))
            .collect();

        // Update fixed cells that were re-solved
        for fc in &mut active_fixed {
            let key = fc.0.key();
            if let Some(new_tile) = local_tile_map.get(&key) {
                let new_state = TileState {
                    tile_id: new_tile.tile_id,
                    rotation: new_tile.rotation,
                    level: new_tile.level,
                };
                if fc.1 != new_state {
                    changed_fixed.push(CollapsedTile {
                        q: fc.0.q,
                        r: fc.0.r,
                        s: fc.0.s,
                        tile_id: new_tile.tile_id,
                        rotation: new_tile.rotation,
                        level: new_tile.level,
                    });
                    fc.1 = new_state;
                }
            }
        }

        // Retry main solve with updated fixed cells
        let result = attempt_solve(
            &global_coords,
            &active_fixed,
            &dropped_cubes,
            seed + 2000 + local_attempt as u64,
            allowed_types,
        );
        stats.tries += 1;
        stats.backtracks += result.backtracks;

        if result.success {
            return build_grid_result(result, changed_fixed, dropped_cubes, stats);
        }
    }

    // Layer 2: Drop fixed cells one by one (nearest to center first)
    let mut droppable: Vec<(CubeCoord, TileState)> = active_fixed.clone();
    droppable.sort_by_key(|(coord, _)| coord.distance(&center));

    for (drop_coord, _) in &droppable {
        dropped_cubes.push(*drop_coord);
        stats.dropped_count += 1;

        let remaining_fixed: Vec<(CubeCoord, TileState)> = active_fixed
            .iter()
            .filter(|(c, _)| !dropped_cubes.iter().any(|d| d == c))
            .cloned()
            .collect();

        let result = attempt_solve(
            &global_coords,
            &remaining_fixed,
            &dropped_cubes,
            seed + 3000 + stats.dropped_count as u64,
            allowed_types,
        );
        stats.tries += 1;
        stats.backtracks += result.backtracks;

        if result.success {
            return build_grid_result(result, changed_fixed, dropped_cubes, stats);
        }
    }

    // Total failure
    build_fallback_grid_result(global_coords, changed_fixed, dropped_cubes, stats)
}

/// Attempt a single WFC solve with the given constraints.
fn attempt_solve(
    coords: &[CubeCoord],
    fixed_cells: &[(CubeCoord, TileState)],
    dropped: &[CubeCoord],
    seed: u64,
    allowed_types: Option<&[u16]>,
) -> SolveResult {
    let dropped_set: HashSet<String> = dropped.iter().map(|c| c.key()).collect();
    let active_fixed_cells = fixed_cells
        .iter()
        .filter(|(coord, _)| !dropped_set.contains(&coord.key()))
        .cloned()
        .collect::<Vec<_>>();

    let mut grid = WfcGrid::new(coords, &active_fixed_cells, allowed_types);

    let mut solver = Solver::new(seed, MAX_BACKTRACKS);
    solver.solve(&mut grid)
}

fn find_conflict_center(
    fixed_cells: &[(CubeCoord, TileState)],
    grid_center: CubeCoord,
) -> Option<CubeCoord> {
    // Return the fixed cell nearest to the grid center
    fixed_cells
        .iter()
        .min_by_key(|(coord, _)| coord.distance(&grid_center))
        .map(|(coord, _)| *coord)
}

fn build_grid_result(
    solve_result: SolveResult,
    changed_fixed: Vec<CollapsedTile>,
    dropped_cubes: Vec<CubeCoord>,
    stats: SolveStats,
) -> GridSolveResult {
    GridSolveResult {
        status: GridSolveStatus::Solved,
        success: solve_result.success,
        tiles: solve_result.tiles,
        collapse_order: solve_result.collapse_order,
        changed_fixed_cells: changed_fixed,
        dropped_cubes,
        stats,
    }
}

fn build_fallback_grid_result(
    coords: Vec<CubeCoord>,
    changed_fixed: Vec<CollapsedTile>,
    dropped_cubes: Vec<CubeCoord>,
    stats: SolveStats,
) -> GridSolveResult {
    let tiles = coords
        .into_iter()
        .map(|coord| CollapsedTile {
            q: coord.q,
            r: coord.r,
            s: coord.s,
            tile_id: WATER_TILE_ID,
            rotation: 0,
            level: 0,
        })
        .collect();

    GridSolveResult {
        status: GridSolveStatus::FallbackWater,
        success: true,
        tiles,
        collapse_order: Vec::new(),
        changed_fixed_cells: changed_fixed,
        dropped_cubes,
        stats,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grid_center_origin() {
        let center = grid_center(CubeCoord::new(0, 0), 8);
        assert_eq!(center, CubeCoord::new(0, 0));
    }

    #[test]
    fn grid_center_ne() {
        let center = grid_center(CubeCoord::new(1, -1), 8);
        assert_eq!(center, CubeCoord::new(17, -17));
    }

    #[test]
    fn grid_center_scale() {
        // grid at (1, 0, -1) → center (17, 0, -17)
        let center = grid_center(CubeCoord::new(1, 0), 8);
        assert_eq!(center.q, 17);
        assert_eq!(center.r, 0);
        assert_eq!(center.s, -17);
    }

    #[test]
    fn adjacent_grid_boundaries_are_neighbors() {
        // Verify grid A's NE boundary is adjacent to grid B's SW boundary
        let a_center = grid_center(CubeCoord::new(0, 0), 8);
        let b_center = grid_center(CubeCoord::new(1, -1), 8); // NE grid

        // A's extreme NE cell
        let a_ne = CubeCoord::new(a_center.q + 8, a_center.r - 8);
        // B's extreme SW cell
        let b_sw = CubeCoord::new(b_center.q - 8, b_center.r + 8);

        assert_eq!(a_ne.distance(&b_sw), 1, "boundary cells should be adjacent");
    }

    #[test]
    fn all_19_grid_positions() {
        let positions = all_grid_positions();
        assert_eq!(positions.len(), 19);
    }

    #[test]
    fn all_grid_positions_use_canonical_order() {
        let positions = all_grid_positions();
        let expected = vec![
            CubeCoord::new(0, 0),
            CubeCoord::new(-1, 0),
            CubeCoord::new(-1, 1),
            CubeCoord::new(0, -1),
            CubeCoord::new(0, 1),
            CubeCoord::new(1, -1),
            CubeCoord::new(1, 0),
            CubeCoord::new(-2, 0),
            CubeCoord::new(-2, 1),
            CubeCoord::new(-2, 2),
            CubeCoord::new(-1, -1),
            CubeCoord::new(-1, 2),
            CubeCoord::new(0, -2),
            CubeCoord::new(0, 2),
            CubeCoord::new(1, -2),
            CubeCoord::new(1, 1),
            CubeCoord::new(2, -2),
            CubeCoord::new(2, -1),
            CubeCoord::new(2, 0),
        ];

        assert_eq!(positions, expected);
    }

    #[test]
    fn local_global_roundtrip() {
        let center = grid_center(CubeCoord::new(1, -1), 8);
        let local = CubeCoord::new(3, -2);
        let global = local_to_global(local, center);
        let back = global_to_local(global, center);
        assert_eq!(back, local);
    }

    #[test]
    fn global_cell_map_insert_and_retrieve() {
        let mut map = GlobalCellMap::new();
        let cell = GlobalCell {
            coord: CubeCoord::new(5, -3),
            tile_id: 2,
            rotation: 1,
            level: 0,
            grid_key: "0,0,0".to_string(),
        };
        map.insert(cell);
        assert_eq!(map.len(), 1);
        assert!(map.contains("5,-3,-2"));
    }

    #[test]
    fn get_fixed_cells_from_neighbors() {
        let mut global_map = GlobalCellMap::new();

        // Add a solved cell at (1, 0, -1)
        global_map.insert(GlobalCell {
            coord: CubeCoord::new(1, 0),
            tile_id: 0,
            rotation: 0,
            level: 0,
            grid_key: "grid_a".to_string(),
        });

        // Solve set includes (0, 0, 0) which is a neighbor of (1, 0, -1)
        let mut solve_set = HashSet::new();
        solve_set.insert(CubeCoord::new(0, 0).key());

        let fixed = get_fixed_cells(&solve_set, &global_map);
        assert_eq!(fixed.len(), 1);
        assert_eq!(fixed[0].0, CubeCoord::new(1, 0));
    }

    #[test]
    fn solve_single_grid_no_constraints() {
        let result = solve_grid(CubeCoord::new(0, 0), &GlobalCellMap::new(), 42, None);
        assert!(
            result.success,
            "single grid should solve without constraints (stats: {:?})",
            result.stats
        );
        assert_eq!(result.tiles.len(), 217);
    }

    #[test]
    fn solve_two_adjacent_grids() {
        let mut global_map = GlobalCellMap::new();

        // Solve center grid first
        let result_a = solve_grid(CubeCoord::new(0, 0), &global_map, 42, None);
        assert!(result_a.success, "center grid should solve");

        // Insert center grid results
        let grid_key_a = CubeCoord::new(0, 0).key();
        global_map.insert_result(&result_a.tiles, &grid_key_a);

        // Solve NE grid with boundary constraints
        let result_b = solve_grid(CubeCoord::new(1, -1), &global_map, 43, None);
        assert!(
            result_b.success,
            "NE grid should solve with boundary constraints (stats: {:?})",
            result_b.stats
        );
        assert_eq!(result_b.tiles.len(), 217);
    }

    #[test]
    fn impossible_allowed_types_fall_back_to_water() {
        let result = solve_grid(CubeCoord::new(0, 0), &GlobalCellMap::new(), 42, Some(&[]));
        assert_eq!(result.status, GridSolveStatus::FallbackWater);
        assert!(result.success);
        assert_eq!(result.tiles.len(), 217);
        assert!(result.tiles.iter().all(|tile| {
            tile.tile_id == WATER_TILE_ID && tile.rotation == 0 && tile.level == 0
        }));
    }

    #[test]
    fn fallback_grid_can_seed_neighbors() {
        let mut global_map = GlobalCellMap::new();
        let fallback = solve_grid(CubeCoord::new(0, 0), &global_map, 42, Some(&[]));
        assert_eq!(fallback.status, GridSolveStatus::FallbackWater);

        let grid_key = CubeCoord::new(0, 0).key();
        global_map.insert_result(&fallback.tiles, &grid_key);

        let neighbor = solve_grid(CubeCoord::new(1, -1), &global_map, 43, None);
        assert!(neighbor.success);
        assert_eq!(neighbor.tiles.len(), 217);
    }
}
