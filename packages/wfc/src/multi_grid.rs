use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use crate::grid_layout as legacy_grid_layout;
use crate::grid::WfcGrid;
use crate::hex::CubeCoord;
use crate::mode::WfcMode;
use crate::rng::{Mulberry32, RandomSource, Rng};
use crate::solver::{
    CollapsedTile, ConflictInfo, SolveResult, SolveTraceEvent, Solver, TraceWatchSnapshot,
};
use crate::tile::{TileState, WATER_TILE_ID};

pub const GRID_RADIUS: i32 = 2;
pub const TILE_RADIUS: i32 = 8;
pub const MAX_BACKTRACKS: u32 = 500;
pub const MAX_TRIES: u32 = 2;
pub const MAX_LOCAL_ATTEMPTS: u32 = 5;
pub const LOCAL_SOLVE_RADIUS: i32 = 2;
pub const BUILD_ALL_TRIES: u32 = 5;
const GRASS_TILE_ID: u16 = 0;

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

#[derive(Clone, Debug, Default)]
pub struct SolveStats {
    pub backtracks: u32,
    pub tries: u32,
    pub local_wfc_attempts: u32,
    pub dropped_count: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GridSolveStatus {
    Solved,
    Failed,
    FallbackWater,
}

impl GridSolveStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            GridSolveStatus::Solved => "solved",
            GridSolveStatus::Failed => "failed",
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
    pub unfixed_cells: Vec<CubeCoord>,
    pub dropped_cubes: Vec<CubeCoord>,
    pub last_conflict: Option<ConflictInfo>,
    pub neighbor_conflict: Option<ConflictInfo>,
    pub stats: SolveStats,
    pub(crate) persisted_replacements: Vec<CollapsedTile>,
}

#[derive(Clone, Debug)]
pub struct SinglePassSolveResult {
    pub status: GridSolveStatus,
    pub success: bool,
    pub tiles: Vec<CollapsedTile>,
    pub collapse_order: Vec<CollapsedTile>,
    pub last_conflict: Option<ConflictInfo>,
    pub neighbor_conflict: Option<ConflictInfo>,
    pub stats: SolveStats,
}

#[derive(Clone, Debug)]
pub struct LegacyTraceGridResult {
    pub success: bool,
    pub tiles: Vec<CollapsedTile>,
    pub collapse_order: Vec<CollapsedTile>,
    pub fixed_cells: Vec<CollapsedTile>,
    pub initial_collapses: Vec<CollapsedTile>,
    pub trace: Vec<SolveTraceEvent>,
    pub watched_snapshots: Vec<TraceWatchSnapshot>,
    pub last_conflict: Option<ConflictInfo>,
    pub neighbor_conflict: Option<ConflictInfo>,
    pub backtracks: u32,
    pub tries: u32,
    pub normalized_result: Option<GridSolveResult>,
}

#[derive(Clone, Debug)]
pub struct LegacyTraceSinglePassResult {
    pub success: bool,
    pub tiles: Vec<CollapsedTile>,
    pub collapse_order: Vec<CollapsedTile>,
    pub fixed_cells: Vec<CollapsedTile>,
    pub initial_collapses: Vec<CollapsedTile>,
    pub trace: Vec<SolveTraceEvent>,
    pub watched_snapshots: Vec<TraceWatchSnapshot>,
    pub last_conflict: Option<ConflictInfo>,
    pub neighbor_conflict: Option<ConflictInfo>,
    pub backtracks: u32,
    pub tries: u32,
    pub normalized_result: Option<SinglePassSolveResult>,
}

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

    pub fn get_mut(&mut self, key: &str) -> Option<&mut GlobalCell> {
        self.cells.get_mut(key)
    }

    pub fn contains(&self, key: &str) -> bool {
        self.cells.contains_key(key)
    }

    pub fn insert(&mut self, cell: GlobalCell) {
        self.cells.insert(cell.coord.key(), cell);
    }

    pub fn insert_result(&mut self, tiles: &[CollapsedTile], grid_key: &str) {
        for tile in tiles {
            self.insert(GlobalCell {
                coord: CubeCoord::new(tile.q, tile.r),
                tile_id: tile.tile_id,
                rotation: tile.rotation,
                level: tile.level,
                grid_key: grid_key.to_string(),
            });
        }
    }

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

#[derive(Clone, Debug)]
pub struct LegacyEngineState {
    seed: u64,
    pub layout_rng: Mulberry32,
    pub solver_rng: Mulberry32,
    pub water_side_index: Option<usize>,
}

impl LegacyEngineState {
    pub fn new(seed: u64) -> Self {
        Self {
            seed,
            layout_rng: Mulberry32::new(seed),
            solver_rng: Mulberry32::new(seed),
            water_side_index: None,
        }
    }

    pub fn ensure_seed(&mut self, seed: u64) {
        if self.seed == seed {
            return;
        }
        self.seed = seed;
        self.layout_rng.reseed(seed);
        self.solver_rng.reseed(seed);
        self.water_side_index = None;
    }
}

#[derive(Clone, Debug)]
struct NeighborCell {
    tile: CollapsedTile,
    anchors: Vec<CollapsedTile>,
}

#[derive(Clone, Debug)]
struct LegacyGridContext {
    center: CubeCoord,
    solve_cells: Vec<CubeCoord>,
    fixed_cells: Vec<CollapsedTile>,
    initial_collapses: Vec<CollapsedTile>,
    anchor_map: HashMap<String, Vec<CollapsedTile>>,
    persisted_unfixed_keys: HashSet<String>,
    persisted_unfixed_originals: HashMap<String, CollapsedTile>,
    dropped_keys: HashSet<String>,
}

#[derive(Clone, Debug)]
struct LegacyAttemptResult {
    success: bool,
    tiles: Vec<CollapsedTile>,
    collapse_order: Vec<CollapsedTile>,
    changed_fixed_cells: Vec<CollapsedTile>,
    unfixed_cells: Vec<CubeCoord>,
    last_conflict: Option<ConflictInfo>,
    neighbor_conflict: Option<ConflictInfo>,
    backtracks: u32,
    tries: u32,
}

pub fn grid_center(grid_pos: CubeCoord, tile_radius: i32) -> CubeCoord {
    legacy_grid_layout::grid_center(grid_pos, tile_radius)
}

pub fn local_to_global(local: CubeCoord, center: CubeCoord) -> CubeCoord {
    CubeCoord::new(local.q + center.q, local.r + center.r)
}

pub fn global_to_local(global: CubeCoord, center: CubeCoord) -> CubeCoord {
    CubeCoord::new(global.q - center.q, global.r - center.r)
}

pub fn all_grid_positions() -> Vec<CubeCoord> {
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

pub fn solve_grid(
    grid_pos: CubeCoord,
    global_map: &GlobalCellMap,
    seed: u64,
    allowed_types: Option<&[u16]>,
) -> GridSolveResult {
    solve_grid_with_mode(
        grid_pos,
        global_map,
        seed,
        allowed_types,
        WfcMode::ModernFast,
        None,
    )
}

pub fn debug_legacy_trace_grid_once(
    grid_pos: CubeCoord,
    global_map: &GlobalCellMap,
    seed: u64,
    allowed_types: Option<&[u16]>,
    state: &LegacyEngineState,
    watch_steps: &[u32],
    watch_coords: &[CubeCoord],
) -> LegacyTraceGridResult {
    let mut snapshot = state.clone();
    snapshot.ensure_seed(seed);

    let center = grid_center(grid_pos, TILE_RADIUS);
    let solve_cells = CubeCoord::new(0, 0)
        .cells_in_radius(TILE_RADIUS)
        .into_iter()
        .map(|coord| local_to_global(coord, center))
        .collect::<Vec<_>>();
    let fixed_cells = get_fixed_cells_for_coords(&solve_cells, global_map);
    let initial_collapses =
        legacy_initial_collapses(&solve_cells, &fixed_cells, center, &mut snapshot);
    let mut anchor_map = build_anchor_map(&fixed_cells, &solve_cells, global_map);
    let neighbor_cells = fixed_cells
        .iter()
        .map(|tile| NeighborCell {
            tile: *tile,
            anchors: anchor_map.remove(&tile_coord(*tile).key()).unwrap_or_default(),
        })
        .collect::<Vec<_>>();
    let (result, trace, watched_snapshots) = legacy_trace_with_neighbor_recovery(
        &solve_cells,
        &fixed_cells,
        &initial_collapses,
        &neighbor_cells,
        allowed_types,
        &mut snapshot.solver_rng,
        MAX_TRIES,
        watch_steps,
        watch_coords,
    );
    let normalized_result = result.success.then(|| {
        legacy_success_result(
            &LegacyGridContext {
                center,
                solve_cells: solve_cells.clone(),
                fixed_cells: fixed_cells.clone(),
                initial_collapses: initial_collapses.clone(),
                anchor_map: build_anchor_map(&fixed_cells, &solve_cells, global_map),
                persisted_unfixed_keys: HashSet::new(),
                persisted_unfixed_originals: HashMap::new(),
                dropped_keys: HashSet::new(),
            },
            result.clone(),
            SolveStats {
                backtracks: result.backtracks,
                tries: result.tries,
                local_wfc_attempts: 0,
                dropped_count: 0,
            },
        )
    });

    LegacyTraceGridResult {
        success: result.success,
        tiles: result.tiles,
        collapse_order: result.collapse_order,
        fixed_cells,
        initial_collapses,
        trace,
        watched_snapshots,
        last_conflict: result.last_conflict,
        neighbor_conflict: result.neighbor_conflict,
        backtracks: result.backtracks,
        tries: result.tries,
        normalized_result,
    }
}

pub fn debug_legacy_trace_single_pass_once(
    seed: u64,
    allowed_types: Option<&[u16]>,
    state: &LegacyEngineState,
    watch_steps: &[u32],
    watch_coords: &[CubeCoord],
) -> LegacyTraceSinglePassResult {
    let mut snapshot = state.clone();
    snapshot.ensure_seed(seed);

    let all_cells = collect_single_pass_cells();
    let mut initial_collapses = vec![CollapsedTile {
        q: 0,
        r: 0,
        s: 0,
        tile_id: GRASS_TILE_ID,
        rotation: 0,
        level: 0,
    }];
    initial_collapses.extend(map_corner_ocean_seeds(&mut snapshot));

    let (result, trace, watched_snapshots) = plain_solve_with_trace_and_retries(
        &all_cells,
        &[],
        &initial_collapses,
        allowed_types,
        BUILD_ALL_TRIES,
        &mut snapshot.solver_rng,
        WfcMode::LegacyCompat,
        watch_steps,
        watch_coords,
    );

    let normalized_result = result.success.then(|| SinglePassSolveResult {
        status: GridSolveStatus::Solved,
        success: true,
        tiles: result.tiles.clone(),
        collapse_order: result.collapse_order.clone(),
        last_conflict: result.last_conflict.clone(),
        neighbor_conflict: result.neighbor_conflict.clone(),
        stats: SolveStats {
            backtracks: result.backtracks,
            tries: result.tries,
            local_wfc_attempts: 0,
            dropped_count: 0,
        },
    });

    LegacyTraceSinglePassResult {
        success: result.success,
        tiles: result.tiles,
        collapse_order: result.collapse_order,
        fixed_cells: Vec::new(),
        initial_collapses,
        trace,
        watched_snapshots,
        last_conflict: result.last_conflict,
        neighbor_conflict: result.neighbor_conflict,
        backtracks: result.backtracks,
        tries: result.tries,
        normalized_result,
    }
}

pub fn solve_grid_with_mode(
    grid_pos: CubeCoord,
    global_map: &GlobalCellMap,
    seed: u64,
    allowed_types: Option<&[u16]>,
    mode: WfcMode,
    legacy_state: Option<&mut LegacyEngineState>,
) -> GridSolveResult {
    match mode {
        WfcMode::LegacyCompat => {
            let state = legacy_state.expect("legacy mode requires engine state");
            state.ensure_seed(seed);
            legacy_solve_grid(grid_pos, global_map, allowed_types, state)
        }
        WfcMode::ModernFast => modern_solve_grid(grid_pos, global_map, seed, allowed_types),
    }
}

pub fn solve_all_single_pass(
    global_map: &mut GlobalCellMap,
    seed: u64,
    allowed_types: Option<&[u16]>,
    mode: WfcMode,
    legacy_state: Option<&mut LegacyEngineState>,
) -> SinglePassSolveResult {
    match mode {
        WfcMode::LegacyCompat => {
            let state = legacy_state.expect("legacy mode requires engine state");
            state.ensure_seed(seed);
            let result = legacy_single_pass_solve(allowed_types, state);
            if result.success {
                global_map.cells.clear();
                insert_single_pass_result(global_map, &result.tiles);
            }
            result
        }
        WfcMode::ModernFast => {
            let result = modern_single_pass_solve(seed, allowed_types);
            if result.success {
                global_map.cells.clear();
                insert_single_pass_result(global_map, &result.tiles);
            }
            result
        }
    }
}

pub fn grid_position_for_cell(coord: CubeCoord) -> Option<CubeCoord> {
    all_grid_positions()
        .into_iter()
        .find(|grid_pos| coord.distance(&grid_center(*grid_pos, TILE_RADIUS)) <= TILE_RADIUS)
}

pub fn get_fixed_cells_for_coords(
    solve_coords: &[CubeCoord],
    global_map: &GlobalCellMap,
) -> Vec<CollapsedTile> {
    let solve_set = solve_coords.iter().map(CubeCoord::key).collect::<HashSet<_>>();
    let mut fixed = Vec::new();
    let mut seen = HashSet::new();

    for coord in solve_coords {
        for neighbor in coord.neighbors() {
            let key = neighbor.key();
            if solve_set.contains(&key) || !seen.insert(key.clone()) {
                continue;
            }
            if let Some(cell) = global_map.get(&key) {
                fixed.push(CollapsedTile {
                    q: neighbor.q,
                    r: neighbor.r,
                    s: neighbor.s,
                    tile_id: cell.tile_id,
                    rotation: cell.rotation,
                    level: cell.level,
                });
            }
        }
    }

    fixed
}

fn modern_solve_grid(
    grid_pos: CubeCoord,
    global_map: &GlobalCellMap,
    seed: u64,
    allowed_types: Option<&[u16]>,
) -> GridSolveResult {
    let center = grid_center(grid_pos, TILE_RADIUS);
    let global_coords = CubeCoord::new(0, 0)
        .cells_in_radius(TILE_RADIUS)
        .into_iter()
        .map(|coord| local_to_global(coord, center))
        .collect::<Vec<_>>();
    let fixed_cells = get_fixed_cells_for_coords(&global_coords, global_map);

    let mut stats = SolveStats::default();
    let mut dropped_cubes = Vec::new();
    let mut changed_fixed = Vec::new();
    let mut last_conflict = None;
    let mut neighbor_conflict = None;

    for try_idx in 0..MAX_TRIES {
        let result = attempt_solve_modern(
            &global_coords,
            &fixed_cells,
            &dropped_cubes,
            seed + try_idx as u64,
            allowed_types,
        );
        stats.tries += 1;
        stats.backtracks += result.backtracks;
        last_conflict = result.last_conflict.clone();
        neighbor_conflict = result.neighbor_conflict.clone();
        if result.success {
            return build_grid_result(
                GridSolveStatus::Solved,
                result,
                changed_fixed,
                Vec::new(),
                dropped_cubes,
                stats,
            );
        }
    }

    let mut active_fixed = fixed_cells.clone();
    for local_attempt in 0..MAX_LOCAL_ATTEMPTS {
        stats.local_wfc_attempts += 1;
        let Some(conflict_center) = find_conflict_center(&active_fixed, center) else {
            break;
        };
        let local_region = conflict_center
            .cells_in_radius(LOCAL_SOLVE_RADIUS)
            .into_iter()
            .filter(|coord| global_map.contains(&coord.key()))
            .collect::<Vec<_>>();
        if local_region.is_empty() {
            continue;
        }
        let local_fixed = get_fixed_cells_for_coords(&local_region, global_map);
        let local_result = attempt_solve_modern(
            &local_region,
            &local_fixed,
            &[],
            seed + 1000 + local_attempt as u64,
            allowed_types,
        );
        stats.tries += 1;
        stats.backtracks += local_result.backtracks;
        if !local_result.success {
            continue;
        }

        let local_tile_map = local_result
            .tiles
            .iter()
            .map(|tile| (tile_coord(*tile).key(), tile))
            .collect::<HashMap<_, _>>();
        for fixed in &mut active_fixed {
            if let Some(updated) = local_tile_map.get(&tile_coord(*fixed).key()) {
                if !same_tile(*fixed, **updated) {
                    changed_fixed.push(**updated);
                    *fixed = **updated;
                }
            }
        }

        let result = attempt_solve_modern(
            &global_coords,
            &active_fixed,
            &dropped_cubes,
            seed + 2000 + local_attempt as u64,
            allowed_types,
        );
        stats.tries += 1;
        stats.backtracks += result.backtracks;
        last_conflict = result.last_conflict.clone();
        neighbor_conflict = result.neighbor_conflict.clone();
        if result.success {
            return build_grid_result(
                GridSolveStatus::Solved,
                result,
                changed_fixed,
                Vec::new(),
                dropped_cubes,
                stats,
            );
        }
    }

    let mut droppable = active_fixed.clone();
    droppable.sort_by_key(|tile| tile_coord(*tile).distance(&center));
    for tile in droppable {
        let coord = tile_coord(tile);
        dropped_cubes.push(coord);
        stats.dropped_count += 1;
        let result = attempt_solve_modern(
            &global_coords,
            &active_fixed,
            &dropped_cubes,
            seed + 3000 + stats.dropped_count as u64,
            allowed_types,
        );
        stats.tries += 1;
        stats.backtracks += result.backtracks;
        last_conflict = result.last_conflict.clone();
        neighbor_conflict = result.neighbor_conflict.clone();
        if result.success {
            return build_grid_result(
                GridSolveStatus::Solved,
                result,
                changed_fixed,
                Vec::new(),
                dropped_cubes,
                stats,
            );
        }
    }

    build_grid_failure_or_fallback(
        global_coords,
        GridSolveStatus::FallbackWater,
        changed_fixed,
        Vec::new(),
        dropped_cubes,
        stats,
        last_conflict,
        neighbor_conflict,
    )
}

fn legacy_solve_grid(
    grid_pos: CubeCoord,
    global_map: &GlobalCellMap,
    allowed_types: Option<&[u16]>,
    state: &mut LegacyEngineState,
) -> GridSolveResult {
    let center = grid_center(grid_pos, TILE_RADIUS);
    let solve_cells = CubeCoord::new(0, 0)
        .cells_in_radius(TILE_RADIUS)
        .into_iter()
        .map(|coord| local_to_global(coord, center))
        .collect::<Vec<_>>();
    let fixed_cells = get_fixed_cells_for_coords(&solve_cells, global_map);
    let initial_collapses = legacy_initial_collapses(&solve_cells, &fixed_cells, center, state);
    let anchor_map = build_anchor_map(&fixed_cells, &solve_cells, global_map);
    let mut ctx = LegacyGridContext {
        center,
        solve_cells,
        fixed_cells,
        initial_collapses,
        anchor_map,
        persisted_unfixed_keys: HashSet::new(),
        persisted_unfixed_originals: HashMap::new(),
        dropped_keys: HashSet::new(),
    };
    legacy_run_with_recovery(&mut ctx, global_map, allowed_types, &mut state.solver_rng)
}

fn modern_single_pass_solve(
    seed: u64,
    allowed_types: Option<&[u16]>,
) -> SinglePassSolveResult {
    let all_cells = collect_single_pass_cells();
    let initial_collapses = vec![CollapsedTile {
        q: 0,
        r: 0,
        s: 0,
        tile_id: GRASS_TILE_ID,
        rotation: 0,
        level: 0,
    }];
    let mut rng = Rng::new(seed);
    let result = plain_solve_with_mode(
        &all_cells,
        &[],
        &initial_collapses,
        allowed_types,
        BUILD_ALL_TRIES,
        &mut rng,
        WfcMode::ModernFast,
    );
    if result.success {
        return SinglePassSolveResult {
            status: GridSolveStatus::Solved,
            success: true,
            tiles: result.tiles,
            collapse_order: result.collapse_order,
            last_conflict: result.last_conflict,
            neighbor_conflict: result.neighbor_conflict,
            stats: SolveStats {
                backtracks: result.backtracks,
                tries: result.tries,
                local_wfc_attempts: 0,
                dropped_count: 0,
            },
        };
    }

    SinglePassSolveResult {
        status: GridSolveStatus::FallbackWater,
        success: true,
        tiles: all_cells
            .into_iter()
            .map(|coord| CollapsedTile {
                q: coord.q,
                r: coord.r,
                s: coord.s,
                tile_id: WATER_TILE_ID,
                rotation: 0,
                level: 0,
            })
            .collect(),
        collapse_order: Vec::new(),
        last_conflict: result.last_conflict,
        neighbor_conflict: result.neighbor_conflict,
        stats: SolveStats {
            backtracks: result.backtracks,
            tries: result.tries,
            local_wfc_attempts: 0,
            dropped_count: 0,
        },
    }
}

fn legacy_single_pass_solve(
    allowed_types: Option<&[u16]>,
    state: &mut LegacyEngineState,
) -> SinglePassSolveResult {
    let all_cells = collect_single_pass_cells();
    let mut initial_collapses = vec![CollapsedTile {
        q: 0,
        r: 0,
        s: 0,
        tile_id: GRASS_TILE_ID,
        rotation: 0,
        level: 0,
    }];
    initial_collapses.extend(map_corner_ocean_seeds(state));

    let result = plain_solve_with_mode(
        &all_cells,
        &[],
        &initial_collapses,
        allowed_types,
        BUILD_ALL_TRIES,
        &mut state.solver_rng,
        WfcMode::LegacyCompat,
    );
    SinglePassSolveResult {
        status: if result.success {
            GridSolveStatus::Solved
        } else {
            GridSolveStatus::Failed
        },
        success: result.success,
        tiles: result.tiles,
        collapse_order: result.collapse_order,
        last_conflict: result.last_conflict,
        neighbor_conflict: result.neighbor_conflict,
        stats: SolveStats {
            backtracks: result.backtracks,
            tries: result.tries,
            local_wfc_attempts: 0,
            dropped_count: 0,
        },
    }
}

fn legacy_run_with_recovery<R: RandomSource>(
    ctx: &mut LegacyGridContext,
    global_map: &GlobalCellMap,
    allowed_types: Option<&[u16]>,
    rng: &mut R,
) -> GridSolveResult {
    let mut stats = SolveStats::default();
    let mut working_map = clone_global_map(global_map);
    let mut result = legacy_run_attempt(ctx, allowed_types, rng);
    stats.backtracks += result.backtracks;
    stats.tries += result.tries;

    if result.success {
        return legacy_success_result(ctx, result, stats);
    }

    let mut failed_cell = conflict_target(result.neighbor_conflict.clone().or(result.last_conflict.clone()));
    let mut is_neighbor_conflict = result.neighbor_conflict.is_some();
    let mut source_coord: Option<CubeCoord> = result
        .neighbor_conflict
        .as_ref()
        .and_then(conflict_source);

    let mut resolved_regions = HashSet::new();
    for local_attempt in 0..MAX_LOCAL_ATTEMPTS {
        let Some(failed) = failed_cell else {
            break;
        };
        let center = if local_attempt == 0 && is_neighbor_conflict {
            if let Some(source) = source_coord {
                resolved_regions.insert(source.key());
                source
            } else {
                choose_nearest_fixed_center(&ctx.fixed_cells, &ctx.dropped_keys, &resolved_regions, failed)
                    .unwrap_or(ctx.center)
            }
        } else if let Some(center) =
            choose_nearest_fixed_center(&ctx.fixed_cells, &ctx.dropped_keys, &resolved_regions, failed)
        {
            resolved_regions.insert(center.key());
            center
        } else {
            break;
        };

        stats.local_wfc_attempts += 1;
        let local_solve_cells = center
            .cells_in_radius(LOCAL_SOLVE_RADIUS)
            .into_iter()
            .filter(|coord: &CubeCoord| working_map.contains(&coord.key()))
            .collect::<Vec<_>>();
        if local_solve_cells.is_empty() {
            continue;
        }

        let local_fixed = get_fixed_cells_for_coords(&local_solve_cells, &working_map);
        let local_result = plain_solve_with_mode(
            &local_solve_cells,
            &local_fixed,
            &[],
            allowed_types,
            BUILD_ALL_TRIES,
            rng,
            WfcMode::LegacyCompat,
        );
        if !local_result.success {
            continue;
        }

        apply_local_result_to_map(&local_result.tiles, &mut working_map);
        ctx.fixed_cells = get_fixed_cells_for_coords(&ctx.solve_cells, &working_map);
        ctx.anchor_map = build_anchor_map(&ctx.fixed_cells, &ctx.solve_cells, &working_map);
        ctx.persisted_unfixed_keys.clear();
        ctx.persisted_unfixed_originals.clear();

        result = legacy_run_attempt(ctx, allowed_types, rng);
        stats.backtracks += result.backtracks;
        stats.tries += result.tries;
        if result.success {
            return legacy_success_result(ctx, result, stats);
        }

        failed_cell = conflict_target(result.neighbor_conflict.clone().or(result.last_conflict.clone()));
        is_neighbor_conflict = result.neighbor_conflict.is_some();
        source_coord = result
            .neighbor_conflict
            .as_ref()
            .and_then(conflict_source);
    }

    ctx.persisted_unfixed_keys.clear();
    ctx.persisted_unfixed_originals.clear();
    while let Some(drop_key) =
        choose_drop_candidate(&ctx.fixed_cells, &ctx.dropped_keys, failed_cell.unwrap_or(ctx.center))
    {
        ctx.dropped_keys.insert(drop_key.clone());
        stats.dropped_count += 1;
        result = legacy_run_attempt(ctx, allowed_types, rng);
        stats.backtracks += result.backtracks;
        stats.tries += result.tries;
        if result.success {
            return legacy_success_result(ctx, result, stats);
        }
        failed_cell = conflict_target(result.neighbor_conflict.clone().or(result.last_conflict.clone()));
    }

    GridSolveResult {
        status: GridSolveStatus::Failed,
        success: false,
        tiles: Vec::new(),
        collapse_order: Vec::new(),
        changed_fixed_cells: Vec::new(),
        unfixed_cells: Vec::new(),
        dropped_cubes: ctx
            .dropped_keys
            .iter()
            .filter_map(|key| parse_cube_key(key))
            .collect(),
        last_conflict: result.last_conflict,
        neighbor_conflict: result.neighbor_conflict,
        stats,
        persisted_replacements: Vec::new(),
    }
}

fn legacy_success_result(
    ctx: &LegacyGridContext,
    result: LegacyAttemptResult,
    stats: SolveStats,
) -> GridSolveResult {
    let persisted_replacements =
        compute_persisted_replacements(&result.tiles, &ctx.persisted_unfixed_originals);
    let unfixed_keys = result
        .unfixed_cells
        .iter()
        .map(CubeCoord::key)
        .chain(ctx.persisted_unfixed_keys.iter().cloned())
        .collect::<HashSet<_>>();
    let tiles = if unfixed_keys.is_empty() {
        result.tiles
    } else {
        result
            .tiles
            .into_iter()
            .filter(|tile| !unfixed_keys.contains(&tile_coord(*tile).key()))
            .collect()
    };
    let collapse_order = if unfixed_keys.is_empty() {
        result.collapse_order
    } else {
        result
            .collapse_order
            .into_iter()
            .filter(|tile| !unfixed_keys.contains(&tile_coord(*tile).key()))
            .collect()
    };
    let unfixed_cells = unfixed_keys
        .into_iter()
        .filter_map(|key| parse_cube_key(&key))
        .collect();

    GridSolveResult {
        status: GridSolveStatus::Solved,
        success: true,
        tiles,
        collapse_order,
        changed_fixed_cells: result.changed_fixed_cells,
        unfixed_cells,
        dropped_cubes: ctx
            .dropped_keys
            .iter()
            .filter_map(|key| parse_cube_key(key))
            .collect(),
        last_conflict: None,
        neighbor_conflict: None,
        stats,
        persisted_replacements,
    }
}

fn legacy_run_attempt<R: RandomSource>(
    ctx: &mut LegacyGridContext,
    allowed_types: Option<&[u16]>,
    rng: &mut R,
) -> LegacyAttemptResult {
    let active_fixed = ctx
        .fixed_cells
        .iter()
        .filter(|tile| !ctx.dropped_keys.contains(&tile_coord(**tile).key()))
        .copied()
        .collect::<Vec<_>>();
    let mut active_solve = ctx.solve_cells.clone();
    let mut active_fixed = active_fixed;

    if !ctx.persisted_unfixed_keys.is_empty() {
        let mut solve_set = active_solve.iter().map(CubeCoord::key).collect::<HashSet<_>>();
        let mut fixed_set = active_fixed
            .iter()
            .map(|tile| tile_coord(*tile).key())
            .collect::<HashSet<_>>();
        let mut anchors_to_add = Vec::new();

        for key in &ctx.persisted_unfixed_keys {
            if let Some(coord) = parse_cube_key(key) {
                if solve_set.insert(coord.key()) {
                    active_solve.push(coord);
                }
            }
            for anchor in ctx.anchor_map.get(key).into_iter().flatten() {
                let anchor_key = tile_coord(*anchor).key();
                if !solve_set.contains(&anchor_key) && fixed_set.insert(anchor_key) {
                    anchors_to_add.push(*anchor);
                }
            }
        }

        active_fixed.retain(|tile| !ctx.persisted_unfixed_keys.contains(&tile_coord(*tile).key()));
        active_fixed.extend(anchors_to_add);
    }

    let neighbor_cells = active_fixed
        .iter()
        .filter(|tile| !ctx.persisted_unfixed_keys.contains(&tile_coord(**tile).key()))
        .map(|tile| NeighborCell {
            tile: *tile,
            anchors: ctx
                .anchor_map
                .get(&tile_coord(*tile).key())
                .cloned()
                .unwrap_or_default(),
        })
        .collect::<Vec<_>>();

    let result = legacy_solve_with_neighbor_recovery(
        &active_solve,
        &active_fixed,
        &ctx.initial_collapses,
        &neighbor_cells,
        allowed_types,
        rng,
        MAX_TRIES,
    );

    if !result.success {
        for coord in &result.unfixed_cells {
            let key = coord.key();
            if ctx.persisted_unfixed_keys.insert(key.clone()) {
                if let Some(original) = ctx
                    .fixed_cells
                    .iter()
                    .copied()
                    .find(|tile| tile_coord(*tile) == *coord)
                {
                    ctx.persisted_unfixed_originals.insert(key, original);
                }
            }
        }
    }

    result
}

fn legacy_solve_with_neighbor_recovery<R: RandomSource>(
    solve_cells: &[CubeCoord],
    fixed_cells: &[CollapsedTile],
    initial_collapses: &[CollapsedTile],
    neighbor_cells: &[NeighborCell],
    allowed_types: Option<&[u16]>,
    rng: &mut R,
    max_tries: u32,
) -> LegacyAttemptResult {
    let mut current_solve = solve_cells.to_vec();
    let mut current_fixed = fixed_cells.to_vec();
    let mut neighbor_data = neighbor_cells
        .iter()
        .map(|neighbor| (tile_coord(neighbor.tile).key(), neighbor.clone()))
        .collect::<HashMap<_, _>>();
    let neighbor_originals = neighbor_cells
        .iter()
        .map(|neighbor| (tile_coord(neighbor.tile).key(), neighbor.tile))
        .collect::<HashMap<_, _>>();
    let mut unfixed_keys = Vec::new();
    let mut total_backtracks = 0;
    let mut last_conflict = None;
    let mut neighbor_conflict = None;

    for attempt in 1..=max_tries {
        loop {
            let result = solve_once(
                &current_solve,
                &current_fixed,
                initial_collapses,
                allowed_types,
                rng,
                WfcMode::LegacyCompat,
            );
            total_backtracks += result.backtracks;
            last_conflict = result.last_conflict.clone();
            if result.success {
                let changed_fixed_cells =
                    compute_changed_fixed(&result.tiles, &unfixed_keys, &neighbor_originals);
                return LegacyAttemptResult {
                    success: true,
                    tiles: result.tiles,
                    collapse_order: result.collapse_order,
                    changed_fixed_cells,
                    unfixed_cells: unfixed_keys
                        .iter()
                        .filter_map(|key| parse_cube_key(key))
                        .collect(),
                    last_conflict: result.last_conflict,
                    neighbor_conflict: result.neighbor_conflict,
                    backtracks: total_backtracks,
                    tries: attempt,
                };
            }

            let Some(conflict) = result.neighbor_conflict.clone() else {
                break;
            };
            let candidates = find_adjacent_neighbor_candidates(&conflict, &current_fixed, &neighbor_data);
            if candidates.is_empty() {
                neighbor_conflict = Some(conflict);
                return LegacyAttemptResult {
                    success: false,
                    tiles: Vec::new(),
                    collapse_order: Vec::new(),
                    changed_fixed_cells: Vec::new(),
                    unfixed_cells: unfixed_keys
                        .iter()
                        .filter_map(|key| parse_cube_key(key))
                        .collect(),
                    last_conflict,
                    neighbor_conflict,
                    backtracks: total_backtracks,
                    tries: 0,
                };
            }

            unfix_neighbor(
                &candidates[0],
                &mut current_solve,
                &mut current_fixed,
                &mut neighbor_data,
                &mut unfixed_keys,
            );
        }
    }

    LegacyAttemptResult {
        success: false,
        tiles: Vec::new(),
        collapse_order: Vec::new(),
        changed_fixed_cells: Vec::new(),
        unfixed_cells: unfixed_keys
            .iter()
            .filter_map(|key| parse_cube_key(key))
            .collect(),
        last_conflict,
        neighbor_conflict,
        backtracks: total_backtracks,
        tries: max_tries,
    }
}

fn plain_solve_with_mode<R: RandomSource>(
    solve_cells: &[CubeCoord],
    fixed_cells: &[CollapsedTile],
    initial_collapses: &[CollapsedTile],
    allowed_types: Option<&[u16]>,
    max_tries: u32,
    rng: &mut R,
    mode: WfcMode,
) -> LegacyAttemptResult {
    let mut total_backtracks = 0;
    let mut last_conflict = None;
    let mut neighbor_conflict = None;
    for attempt in 1..=max_tries {
        let result = solve_once(
            solve_cells,
            fixed_cells,
            initial_collapses,
            allowed_types,
            rng,
            mode,
        );
        total_backtracks += result.backtracks;
        last_conflict = result.last_conflict.clone();
        neighbor_conflict = result.neighbor_conflict.clone();
        if result.success {
            return LegacyAttemptResult {
                success: true,
                tiles: result.tiles,
                collapse_order: result.collapse_order,
                changed_fixed_cells: Vec::new(),
                unfixed_cells: Vec::new(),
                last_conflict: result.last_conflict,
                neighbor_conflict: result.neighbor_conflict,
                backtracks: total_backtracks,
                tries: attempt,
            };
        }
    }

    LegacyAttemptResult {
        success: false,
        tiles: Vec::new(),
        collapse_order: Vec::new(),
        changed_fixed_cells: Vec::new(),
        unfixed_cells: Vec::new(),
        last_conflict,
        neighbor_conflict,
        backtracks: total_backtracks,
        tries: max_tries,
    }
}

fn plain_solve_with_trace_and_retries<R: RandomSource>(
    solve_cells: &[CubeCoord],
    fixed_cells: &[CollapsedTile],
    initial_collapses: &[CollapsedTile],
    allowed_types: Option<&[u16]>,
    max_tries: u32,
    rng: &mut R,
    mode: WfcMode,
    watch_steps: &[u32],
    watch_coords: &[CubeCoord],
) -> (LegacyAttemptResult, Vec<SolveTraceEvent>, Vec<TraceWatchSnapshot>) {
    let mut total_backtracks = 0;
    let mut last_conflict = None;
    let mut neighbor_conflict = None;
    let mut last_trace = Vec::new();
    let mut last_watched_snapshots = Vec::new();

    for attempt in 1..=max_tries {
        let (result, trace, watched_snapshots) = solve_once_with_trace(
            solve_cells,
            fixed_cells,
            initial_collapses,
            allowed_types,
            rng,
            mode,
            watch_steps,
            watch_coords,
        );
        total_backtracks += result.backtracks;
        last_conflict = result.last_conflict.clone();
        neighbor_conflict = result.neighbor_conflict.clone();
        last_trace = trace;
        last_watched_snapshots = watched_snapshots;
        if result.success {
            return (
                LegacyAttemptResult {
                    success: true,
                    tiles: result.tiles,
                    collapse_order: result.collapse_order,
                    changed_fixed_cells: Vec::new(),
                    unfixed_cells: Vec::new(),
                    last_conflict: result.last_conflict,
                    neighbor_conflict: result.neighbor_conflict,
                    backtracks: total_backtracks,
                    tries: attempt,
                },
                last_trace,
                last_watched_snapshots,
            );
        }
    }

    (
        LegacyAttemptResult {
            success: false,
            tiles: Vec::new(),
            collapse_order: Vec::new(),
            changed_fixed_cells: Vec::new(),
            unfixed_cells: Vec::new(),
            last_conflict,
            neighbor_conflict,
            backtracks: total_backtracks,
            tries: max_tries,
        },
        last_trace,
        last_watched_snapshots,
    )
}

fn solve_once<R: RandomSource>(
    solve_cells: &[CubeCoord],
    fixed_cells: &[CollapsedTile],
    initial_collapses: &[CollapsedTile],
    allowed_types: Option<&[u16]>,
    rng: &mut R,
    mode: WfcMode,
) -> SolveResult {
    let fixed = fixed_cells
        .iter()
        .map(|tile| (tile_coord(*tile), tile_state(*tile)))
        .collect::<Vec<_>>();
    let initial = initial_collapses
        .iter()
        .map(|tile| (tile_coord(*tile), tile_state(*tile)))
        .collect::<Vec<_>>();
    let mut grid = WfcGrid::new(solve_cells, &fixed, allowed_types);
    let mut solver = Solver::new(rng, MAX_BACKTRACKS, mode);
    solver.solve(&mut grid, &initial)
}

fn solve_once_with_trace<R: RandomSource>(
    solve_cells: &[CubeCoord],
    fixed_cells: &[CollapsedTile],
    initial_collapses: &[CollapsedTile],
    allowed_types: Option<&[u16]>,
    rng: &mut R,
    mode: WfcMode,
    watch_steps: &[u32],
    watch_coords: &[CubeCoord],
) -> (SolveResult, Vec<SolveTraceEvent>, Vec<TraceWatchSnapshot>) {
    let fixed = fixed_cells
        .iter()
        .map(|tile| (tile_coord(*tile), tile_state(*tile)))
        .collect::<Vec<_>>();
    let initial = initial_collapses
        .iter()
        .map(|tile| (tile_coord(*tile), tile_state(*tile)))
        .collect::<Vec<_>>();
    let mut grid = WfcGrid::new(solve_cells, &fixed, allowed_types);
    let mut solver = Solver::new(rng, MAX_BACKTRACKS, mode);
    solver.solve_with_trace_and_watches(&mut grid, &initial, watch_steps, watch_coords)
}

fn legacy_trace_with_neighbor_recovery<R: RandomSource>(
    solve_cells: &[CubeCoord],
    fixed_cells: &[CollapsedTile],
    initial_collapses: &[CollapsedTile],
    neighbor_cells: &[NeighborCell],
    allowed_types: Option<&[u16]>,
    rng: &mut R,
    max_tries: u32,
    watch_steps: &[u32],
    watch_coords: &[CubeCoord],
) -> (LegacyAttemptResult, Vec<SolveTraceEvent>, Vec<TraceWatchSnapshot>) {
    let mut current_solve = solve_cells.to_vec();
    let mut current_fixed = fixed_cells.to_vec();
    let mut neighbor_data = neighbor_cells
        .iter()
        .map(|neighbor| (tile_coord(neighbor.tile).key(), neighbor.clone()))
        .collect::<HashMap<_, _>>();
    let neighbor_originals = neighbor_cells
        .iter()
        .map(|neighbor| (tile_coord(neighbor.tile).key(), neighbor.tile))
        .collect::<HashMap<_, _>>();
    let mut unfixed_keys = Vec::new();
    let mut total_backtracks = 0;
    let mut last_conflict = None;
    let mut neighbor_conflict = None;
    let mut last_trace = Vec::new();
    let mut last_watch_snapshots = Vec::new();

    for attempt in 1..=max_tries {
        loop {
            let (result, trace, watched_snapshots) = solve_once_with_trace(
                &current_solve,
                &current_fixed,
                initial_collapses,
                allowed_types,
                rng,
                WfcMode::LegacyCompat,
                watch_steps,
                watch_coords,
            );
            total_backtracks += result.backtracks;
            last_conflict = result.last_conflict.clone();
            last_trace = trace;
            last_watch_snapshots = watched_snapshots;

            if result.success {
                let changed_fixed_cells =
                    compute_changed_fixed(&result.tiles, &unfixed_keys, &neighbor_originals);
                return (
                    LegacyAttemptResult {
                        success: true,
                        tiles: result.tiles,
                        collapse_order: result.collapse_order,
                        changed_fixed_cells,
                        unfixed_cells: unfixed_keys
                            .iter()
                            .filter_map(|key| parse_cube_key(key))
                            .collect(),
                        last_conflict: result.last_conflict,
                        neighbor_conflict: result.neighbor_conflict,
                        backtracks: total_backtracks,
                        tries: attempt,
                    },
                    last_trace,
                    last_watch_snapshots,
                );
            }

            let Some(conflict) = result.neighbor_conflict.clone() else {
                break;
            };
            let candidates =
                find_adjacent_neighbor_candidates(&conflict, &current_fixed, &neighbor_data);
            if candidates.is_empty() {
                neighbor_conflict = Some(conflict);
                return (
                    LegacyAttemptResult {
                        success: false,
                        tiles: Vec::new(),
                        collapse_order: Vec::new(),
                        changed_fixed_cells: Vec::new(),
                        unfixed_cells: unfixed_keys
                            .iter()
                            .filter_map(|key| parse_cube_key(key))
                            .collect(),
                        last_conflict,
                        neighbor_conflict,
                        backtracks: total_backtracks,
                        tries: 0,
                    },
                    last_trace,
                    last_watch_snapshots,
                );
            }

            unfix_neighbor(
                &candidates[0],
                &mut current_solve,
                &mut current_fixed,
                &mut neighbor_data,
                &mut unfixed_keys,
            );
        }
    }

    (
        LegacyAttemptResult {
            success: false,
            tiles: Vec::new(),
            collapse_order: Vec::new(),
            changed_fixed_cells: Vec::new(),
            unfixed_cells: unfixed_keys
                .iter()
                .filter_map(|key| parse_cube_key(key))
                .collect(),
            last_conflict,
            neighbor_conflict,
            backtracks: total_backtracks,
            tries: max_tries,
        },
        last_trace,
        last_watch_snapshots,
    )
}

fn attempt_solve_modern(
    coords: &[CubeCoord],
    fixed_cells: &[CollapsedTile],
    dropped: &[CubeCoord],
    seed: u64,
    allowed_types: Option<&[u16]>,
) -> SolveResult {
    let dropped_set = dropped.iter().map(CubeCoord::key).collect::<HashSet<_>>();
    let active_fixed = fixed_cells
        .iter()
        .copied()
        .filter(|tile| !dropped_set.contains(&tile_coord(*tile).key()))
        .collect::<Vec<_>>();
    let mut rng = Rng::new(seed);
    solve_once(coords, &active_fixed, &[], allowed_types, &mut rng, WfcMode::ModernFast)
}

fn legacy_initial_collapses(
    solve_cells: &[CubeCoord],
    fixed_cells: &[CollapsedTile],
    center: CubeCoord,
    state: &mut LegacyEngineState,
) -> Vec<CollapsedTile> {
    let mut initial_collapses = Vec::new();
    if fixed_cells.is_empty() {
        initial_collapses.push(CollapsedTile {
            q: center.q,
            r: center.r,
            s: center.s,
            tile_id: GRASS_TILE_ID,
            rotation: 0,
            level: 0,
        });
        add_water_edge_seed(&mut initial_collapses, center, TILE_RADIUS, state);
    }

    let solve_set = solve_cells.iter().map(CubeCoord::key).collect::<HashSet<_>>();
    let fixed_set = fixed_cells
        .iter()
        .map(|tile| tile_coord(*tile).key())
        .collect::<HashSet<_>>();
    for seed in map_corner_ocean_seeds(state) {
        let key = tile_coord(seed).key();
        if solve_set.contains(&key) && !fixed_set.contains(&key) {
            initial_collapses.push(seed);
        }
    }

    initial_collapses
}

fn add_water_edge_seed(
    initial_collapses: &mut Vec<CollapsedTile>,
    center: CubeCoord,
    radius: i32,
    state: &mut LegacyEngineState,
) {
    let dirs = [
        CubeCoord { q: 1, r: -1, s: 0 },
        CubeCoord { q: 1, r: 0, s: -1 },
        CubeCoord { q: 0, r: 1, s: -1 },
        CubeCoord { q: -1, r: 1, s: 0 },
        CubeCoord { q: -1, r: 0, s: 1 },
        CubeCoord { q: 0, r: -1, s: 1 },
    ];
    let side = pick_water_side_index(state);
    let d = dirs[side];
    let d2 = dirs[(side + 1) % 6];
    let half = radius / 2;
    initial_collapses.push(CollapsedTile {
        q: center.q + d.q * (radius - half) + d2.q * half,
        r: center.r + d.r * (radius - half) + d2.r * half,
        s: center.s + d.s * (radius - half) + d2.s * half,
        tile_id: WATER_TILE_ID,
        rotation: 0,
        level: 0,
    });
}

fn map_corner_ocean_seeds(state: &mut LegacyEngineState) -> Vec<CollapsedTile> {
    let cube_dirs = [
        CubeCoord { q: 1, r: -1, s: 0 },
        CubeCoord { q: 1, r: 0, s: -1 },
        CubeCoord { q: 0, r: 1, s: -1 },
        CubeCoord { q: -1, r: 1, s: 0 },
        CubeCoord { q: -1, r: 0, s: 1 },
        CubeCoord { q: 0, r: -1, s: 1 },
    ];
    let side = pick_water_side_index(state);
    let dir = cube_dirs[side];
    let prev_step = cube_dirs[(side + 4) % 6];
    let next_step = cube_dirs[(side + 2) % 6];
    let side_grids = [
        CubeCoord::new(dir.q * 2 + prev_step.q, dir.r * 2 + prev_step.r),
        CubeCoord::new(dir.q * 2, dir.r * 2),
        CubeCoord::new(dir.q * 2 + next_step.q, dir.r * 2 + next_step.r),
        CubeCoord::new(dir.q, dir.r),
    ];

    side_grids
        .into_iter()
        .map(|grid_pos| {
            let center = grid_center(grid_pos, TILE_RADIUS);
            CollapsedTile {
                q: center.q,
                r: center.r,
                s: center.s,
                tile_id: WATER_TILE_ID,
                rotation: 0,
                level: 0,
            }
        })
        .collect()
}

fn pick_water_side_index(state: &mut LegacyEngineState) -> usize {
    if let Some(index) = state.water_side_index {
        return index;
    }
    let index = (state.layout_rng.f64() * 6.0).floor() as usize % 6;
    state.water_side_index = Some(index);
    index
}

fn build_anchor_map(
    fixed_cells: &[CollapsedTile],
    solve_cells: &[CubeCoord],
    global_map: &GlobalCellMap,
) -> HashMap<String, Vec<CollapsedTile>> {
    let solve_set = solve_cells.iter().map(CubeCoord::key).collect::<HashSet<_>>();
    let fixed_set = fixed_cells
        .iter()
        .map(|tile| tile_coord(*tile).key())
        .collect::<HashSet<_>>();

    fixed_cells
        .iter()
        .map(|tile| {
            let coord = tile_coord(*tile);
            let anchors = coord
                .neighbors()
                .into_iter()
                .filter_map(|neighbor| {
                    let key = neighbor.key();
                    if solve_set.contains(&key) || fixed_set.contains(&key) {
                        return None;
                    }
                    let cell = global_map.get(&key)?;
                    Some(CollapsedTile {
                        q: neighbor.q,
                        r: neighbor.r,
                        s: neighbor.s,
                        tile_id: cell.tile_id,
                        rotation: cell.rotation,
                        level: cell.level,
                    })
                })
                .collect::<Vec<_>>();
            (coord.key(), anchors)
        })
        .collect()
}

fn compute_changed_fixed(
    tiles: &[CollapsedTile],
    unfixed_keys: &[String],
    originals: &HashMap<String, CollapsedTile>,
) -> Vec<CollapsedTile> {
    let solved = tiles
        .iter()
        .map(|tile| (tile_coord(*tile).key(), *tile))
        .collect::<HashMap<_, _>>();
    let mut changed = Vec::new();
    for key in unfixed_keys {
        let Some(original) = originals.get(key).copied() else {
            continue;
        };
        let Some(solved_tile) = solved.get(key).copied() else {
            continue;
        };
        if !same_tile(original, solved_tile) {
            changed.push(solved_tile);
        }
    }
    changed
}

fn compute_persisted_replacements(
    tiles: &[CollapsedTile],
    originals: &HashMap<String, CollapsedTile>,
) -> Vec<CollapsedTile> {
    let solved = tiles
        .iter()
        .map(|tile| (tile_coord(*tile).key(), *tile))
        .collect::<HashMap<_, _>>();
    let mut changed = Vec::new();
    for (key, original) in originals {
        let Some(solved_tile) = solved.get(key).copied() else {
            continue;
        };
        if !same_tile(*original, solved_tile) {
            changed.push(solved_tile);
        }
    }
    changed
}

fn find_adjacent_neighbor_candidates(
    conflict: &ConflictInfo,
    fixed_cells: &[CollapsedTile],
    neighbor_data: &HashMap<String, NeighborCell>,
) -> Vec<String> {
    let fixed_keys = fixed_cells
        .iter()
        .map(|tile| tile_coord(*tile).key())
        .collect::<HashSet<_>>();
    let failed = CubeCoord::new(conflict.failed_q, conflict.failed_r);
    let mut candidates = Vec::new();

    if let Some(source) = conflict_source(conflict) {
        let source_key = source.key();
        if fixed_keys.contains(&source_key) && neighbor_data.contains_key(&source_key) {
            candidates.push(source_key);
        }
    }

    for neighbor in failed.neighbors() {
        let key = neighbor.key();
        if fixed_keys.contains(&key) && neighbor_data.contains_key(&key) && !candidates.contains(&key) {
            candidates.push(key);
        }
    }

    candidates
}

fn unfix_neighbor(
    key: &str,
    solve_cells: &mut Vec<CubeCoord>,
    fixed_cells: &mut Vec<CollapsedTile>,
    neighbor_data: &mut HashMap<String, NeighborCell>,
    unfixed_keys: &mut Vec<String>,
) {
    let Some(soft_data) = neighbor_data.remove(key) else {
        return;
    };
    let coord = tile_coord(soft_data.tile);
    fixed_cells.retain(|tile| tile_coord(*tile).key() != key);
    if !solve_cells.iter().any(|existing| *existing == coord) {
        solve_cells.push(coord);
    }

    let solve_set = solve_cells.iter().map(CubeCoord::key).collect::<HashSet<_>>();
    let mut fixed_set = fixed_cells
        .iter()
        .map(|tile| tile_coord(*tile).key())
        .collect::<HashSet<_>>();
    for anchor in soft_data.anchors {
        let anchor_key = tile_coord(anchor).key();
        if !solve_set.contains(&anchor_key) && fixed_set.insert(anchor_key) {
            fixed_cells.push(anchor);
        }
    }

    if !unfixed_keys.iter().any(|existing| existing == key) {
        unfixed_keys.push(key.to_string());
    }
}

fn choose_nearest_fixed_center(
    fixed_cells: &[CollapsedTile],
    dropped_keys: &HashSet<String>,
    resolved_regions: &HashSet<String>,
    failed_cell: CubeCoord,
) -> Option<CubeCoord> {
    fixed_cells
        .iter()
        .map(|tile| tile_coord(*tile))
        .filter(|coord| {
            let key = coord.key();
            !dropped_keys.contains(&key) && !resolved_regions.contains(&key)
        })
        .min_by_key(|coord| coord.distance(&failed_cell))
}

fn choose_drop_candidate(
    fixed_cells: &[CollapsedTile],
    dropped_keys: &HashSet<String>,
    failed_cell: CubeCoord,
) -> Option<String> {
    fixed_cells
        .iter()
        .map(|tile| tile_coord(*tile))
        .filter(|coord| !dropped_keys.contains(&coord.key()))
        .min_by_key(|coord| coord.distance(&failed_cell))
        .map(|coord| coord.key())
}

fn find_conflict_center(fixed_cells: &[CollapsedTile], grid_center: CubeCoord) -> Option<CubeCoord> {
    fixed_cells
        .iter()
        .map(|tile| tile_coord(*tile))
        .min_by_key(|coord| coord.distance(&grid_center))
}

fn build_grid_result(
    status: GridSolveStatus,
    solve_result: SolveResult,
    changed_fixed: Vec<CollapsedTile>,
    unfixed_cells: Vec<CubeCoord>,
    dropped_cubes: Vec<CubeCoord>,
    stats: SolveStats,
) -> GridSolveResult {
    GridSolveResult {
        status,
        success: solve_result.success,
        tiles: solve_result.tiles,
        collapse_order: solve_result.collapse_order,
        changed_fixed_cells: changed_fixed,
        unfixed_cells,
        dropped_cubes,
        last_conflict: solve_result.last_conflict,
        neighbor_conflict: solve_result.neighbor_conflict,
        stats,
        persisted_replacements: Vec::new(),
    }
}

fn build_grid_failure_or_fallback(
    coords: Vec<CubeCoord>,
    status: GridSolveStatus,
    changed_fixed: Vec<CollapsedTile>,
    unfixed_cells: Vec<CubeCoord>,
    dropped_cubes: Vec<CubeCoord>,
    stats: SolveStats,
    last_conflict: Option<ConflictInfo>,
    neighbor_conflict: Option<ConflictInfo>,
) -> GridSolveResult {
    let tiles = match status {
        GridSolveStatus::FallbackWater => coords
            .into_iter()
            .map(|coord| CollapsedTile {
                q: coord.q,
                r: coord.r,
                s: coord.s,
                tile_id: WATER_TILE_ID,
                rotation: 0,
                level: 0,
            })
            .collect(),
        GridSolveStatus::Failed | GridSolveStatus::Solved => Vec::new(),
    };

    GridSolveResult {
        status,
        success: status != GridSolveStatus::Failed,
        tiles,
        collapse_order: Vec::new(),
        changed_fixed_cells: changed_fixed,
        unfixed_cells,
        dropped_cubes,
        last_conflict,
        neighbor_conflict,
        stats,
        persisted_replacements: Vec::new(),
    }
}

fn conflict_target(conflict: Option<ConflictInfo>) -> Option<CubeCoord> {
    conflict.map(|info| CubeCoord::new(info.failed_q, info.failed_r))
}

fn conflict_source(conflict: &ConflictInfo) -> Option<CubeCoord> {
    let info = conflict;
    Some(CubeCoord::new(info.source_q?, info.source_r?))
}

fn apply_local_result_to_map(tiles: &[CollapsedTile], global_map: &mut GlobalCellMap) {
    for tile in tiles {
        let key = tile_coord(*tile).key();
        if let Some(existing) = global_map.get_mut(&key) {
            existing.tile_id = tile.tile_id;
            existing.rotation = tile.rotation;
            existing.level = tile.level;
        }
    }
}

fn clone_global_map(global_map: &GlobalCellMap) -> GlobalCellMap {
    let mut clone = GlobalCellMap::new();
    for cell in global_map.cells.values() {
        clone.insert(cell.clone());
    }
    clone
}

fn insert_single_pass_result(global_map: &mut GlobalCellMap, tiles: &[CollapsedTile]) {
    for grid_pos in all_grid_positions() {
        let grid_key = grid_pos.key();
        let center = grid_center(grid_pos, TILE_RADIUS);
        let grid_tiles = tiles
            .iter()
            .copied()
            .filter(|tile| tile_coord(*tile).distance(&center) <= TILE_RADIUS)
            .collect::<Vec<_>>();
        global_map.insert_result(&grid_tiles, &grid_key);
    }
}

fn collect_single_pass_cells() -> Vec<CubeCoord> {
    let mut solve_set = HashSet::new();
    let mut all_solve = Vec::new();
    for grid_pos in all_grid_positions() {
        let center = grid_center(grid_pos, TILE_RADIUS);
        for coord in center.cells_in_radius(TILE_RADIUS) {
            if solve_set.insert(coord.key()) {
                all_solve.push(coord);
            }
        }
    }
    all_solve
}

fn parse_cube_key(key: &str) -> Option<CubeCoord> {
    let mut parts = key.split(',');
    let q = parts.next()?.parse().ok()?;
    let r = parts.next()?.parse().ok()?;
    Some(CubeCoord::new(q, r))
}

fn tile_coord(tile: CollapsedTile) -> CubeCoord {
    CubeCoord::new(tile.q, tile.r)
}

fn tile_state(tile: CollapsedTile) -> TileState {
    TileState {
        tile_id: tile.tile_id,
        rotation: tile.rotation,
        level: tile.level,
    }
}

fn same_tile(left: CollapsedTile, right: CollapsedTile) -> bool {
    left.tile_id == right.tile_id && left.rotation == right.rotation && left.level == right.level
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::fs;
    use std::path::PathBuf;

    use serde::Deserialize;

    #[derive(Deserialize)]
    struct FixtureEnvelope {
        fixtures: Vec<ProgressiveFixture>,
    }

    #[derive(Deserialize)]
    struct ProgressiveFixture {
        seed: u64,
        mode: String,
        grids: Vec<FixtureGrid>,
    }

    #[derive(Deserialize)]
    struct FixtureGrid {
        #[serde(rename = "gridQ")]
        grid_q: i32,
        #[serde(rename = "gridR")]
        grid_r: i32,
        status: String,
        tiles: Vec<FixtureTile>,
        #[serde(rename = "collapseOrder")]
        collapse_order: Vec<FixtureTile>,
        #[serde(rename = "changedFixedCells")]
        changed_fixed_cells: Vec<FixtureTile>,
        #[serde(rename = "unfixedCells")]
        unfixed_cells: Vec<FixtureCoord>,
        stats: FixtureStats,
    }

    #[derive(Deserialize)]
    struct FixtureTile {
        q: i32,
        r: i32,
        s: i32,
        #[serde(rename = "type")]
        tile_id: u16,
        rotation: u8,
        level: u8,
    }

    #[derive(Deserialize)]
    struct FixtureCoord {
        q: i32,
        r: i32,
        s: i32,
    }

    #[derive(Deserialize)]
    struct FixtureStats {
        tries: u32,
        backtracks: u32,
        #[serde(rename = "localWfcAttempts")]
        local_wfc_attempts: u32,
        #[serde(rename = "droppedCount")]
        dropped_count: u32,
    }

    #[test]
    fn grid_center_origin() {
        assert_eq!(grid_center(CubeCoord::new(0, 0), 8), CubeCoord::new(0, 0));
    }

    #[test]
    fn all_19_grid_positions() {
        assert_eq!(all_grid_positions().len(), 19);
    }

    #[test]
    fn get_fixed_cells_preserves_first_seen_order() {
        let mut global_map = GlobalCellMap::new();
        global_map.insert(GlobalCell {
            coord: CubeCoord::new(1, 0),
            tile_id: 0,
            rotation: 0,
            level: 0,
            grid_key: "a".to_string(),
        });
        let fixed = get_fixed_cells_for_coords(&[CubeCoord::new(0, 0)], &global_map);
        assert_eq!(fixed.len(), 1);
        assert_eq!(tile_coord(fixed[0]), CubeCoord::new(1, 0));
    }

    #[test]
    fn solve_single_grid_no_constraints() {
        let result = solve_grid(CubeCoord::new(0, 0), &GlobalCellMap::new(), 42, None);
        assert!(result.success);
        assert_eq!(result.tiles.len(), 217);
    }

    #[test]
    fn impossible_allowed_types_fall_back_to_water_in_modern_mode() {
        let result = solve_grid(CubeCoord::new(0, 0), &GlobalCellMap::new(), 42, Some(&[]));
        assert_eq!(result.status, GridSolveStatus::FallbackWater);
        assert!(result.success);
    }

    #[test]
    #[ignore = "expensive parity regression; verify with scripts/check-legacy-fixtures.mjs"]
    fn legacy_progressive_seed_2_grid_11_matches_fixture() {
        let fixture = load_progressive_fixture(2);
        let mut global_map = GlobalCellMap::new();
        let mut legacy_state = LegacyEngineState::new(2);

        let target = fixture
            .grids
            .get(11)
            .expect("fixture must include grid index 11");

        for (index, grid) in fixture.grids.iter().enumerate().take(12) {
            let grid_pos = CubeCoord::new(grid.grid_q, grid.grid_r);
            let result = solve_grid_with_mode(
                grid_pos,
                &global_map,
                fixture.seed,
                None,
                WfcMode::LegacyCompat,
                Some(&mut legacy_state),
            );
            apply_grid_result_for_test(&mut global_map, grid_pos, &result);

            if index == 11 {
                let actual_tiles = normalize_tiles(&result.tiles);
                let expected_tiles = normalize_fixture_tiles(&target.tiles);
                let actual_order = normalize_order(&result.collapse_order);
                let expected_order = normalize_fixture_order(&target.collapse_order);

                assert_eq!(result.status.as_str(), target.status);
                assert_eq!(result.stats.tries, target.stats.tries);
                assert_eq!(result.stats.backtracks, target.stats.backtracks);
                assert_eq!(result.stats.local_wfc_attempts, target.stats.local_wfc_attempts);
                assert_eq!(result.stats.dropped_count, target.stats.dropped_count);
                assert_eq!(
                    normalize_tiles(&result.changed_fixed_cells),
                    normalize_fixture_tiles(&target.changed_fixed_cells),
                );
                assert_eq!(
                    normalize_coords(&result.unfixed_cells),
                    normalize_fixture_coords(&target.unfixed_cells),
                );
                assert_eq!(actual_tiles, expected_tiles);
                assert_eq!(actual_order, expected_order);
            }
        }
    }

    fn load_progressive_fixture(seed: u64) -> ProgressiveFixture {
        let fixture_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/legacy-wfc-progressive.json");
        let raw = fs::read_to_string(fixture_path).expect("fixture file should exist");
        let envelope: FixtureEnvelope = serde_json::from_str(&raw).expect("fixture JSON should parse");
        envelope
            .fixtures
            .into_iter()
            .find(|fixture| fixture.mode == "progressive" && fixture.seed == seed)
            .expect("progressive fixture should exist")
    }

    fn apply_grid_result_for_test(
        global_map: &mut GlobalCellMap,
        grid_pos: CubeCoord,
        result: &GridSolveResult,
    ) {
        for changed in &result.changed_fixed_cells {
            let key = tile_coord(*changed).key();
            if let Some(existing) = global_map.get_mut(&key) {
                existing.tile_id = changed.tile_id;
                existing.rotation = changed.rotation;
                existing.level = changed.level;
            }
        }
        for changed in &result.persisted_replacements {
            let key = tile_coord(*changed).key();
            if let Some(existing) = global_map.get_mut(&key) {
                existing.tile_id = changed.tile_id;
                existing.rotation = changed.rotation;
                existing.level = changed.level;
            }
        }
        if !result.success {
            return;
        }

        let grid_key = grid_pos.key();
        let unfixed = result
            .unfixed_cells
            .iter()
            .map(CubeCoord::key)
            .collect::<HashSet<_>>();
        let filtered = result
            .tiles
            .iter()
            .copied()
            .filter(|tile| !unfixed.contains(&tile_coord(*tile).key()))
            .collect::<Vec<_>>();
        global_map.remove_grid(&grid_key);
        global_map.insert_result(&filtered, &grid_key);
    }

    fn normalize_tiles(tiles: &[CollapsedTile]) -> Vec<(i32, i32, i32, u16, u8, u8)> {
        let mut normalized = tiles
            .iter()
            .map(|tile| (tile.q, tile.r, tile.s, tile.tile_id, tile.rotation, tile.level))
            .collect::<Vec<_>>();
        normalized.sort_unstable();
        normalized
    }

    fn normalize_order(tiles: &[CollapsedTile]) -> Vec<(i32, i32, i32, u16, u8, u8)> {
        tiles
            .iter()
            .map(|tile| (tile.q, tile.r, tile.s, tile.tile_id, tile.rotation, tile.level))
            .collect()
    }

    fn normalize_fixture_tiles(tiles: &[FixtureTile]) -> Vec<(i32, i32, i32, u16, u8, u8)> {
        let mut normalized = tiles
            .iter()
            .map(|tile| (tile.q, tile.r, tile.s, tile.tile_id, tile.rotation, tile.level))
            .collect::<Vec<_>>();
        normalized.sort_unstable();
        normalized
    }

    fn normalize_fixture_order(tiles: &[FixtureTile]) -> Vec<(i32, i32, i32, u16, u8, u8)> {
        tiles
            .iter()
            .map(|tile| (tile.q, tile.r, tile.s, tile.tile_id, tile.rotation, tile.level))
            .collect()
    }

    fn normalize_coords(coords: &[CubeCoord]) -> Vec<(i32, i32, i32)> {
        let mut normalized = coords
            .iter()
            .map(|coord| (coord.q, coord.r, coord.s))
            .collect::<Vec<_>>();
        normalized.sort_unstable();
        normalized
    }

    fn normalize_fixture_coords(coords: &[FixtureCoord]) -> Vec<(i32, i32, i32)> {
        let mut normalized = coords
            .iter()
            .map(|coord| (coord.q, coord.r, coord.s))
            .collect::<Vec<_>>();
        normalized.sort_unstable();
        normalized
    }
}
