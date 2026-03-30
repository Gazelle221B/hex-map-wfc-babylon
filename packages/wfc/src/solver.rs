use std::collections::HashSet;
use std::mem;

use indexmap::IndexSet;
use serde::Serialize;

use crate::grid::WfcGrid;
use crate::hex::CubeCoord;
use crate::mode::{SolveBehavior, WfcMode};
use crate::rng::RandomSource;
use crate::tile::{EdgeType, TileState, LEVELS_COUNT};

#[derive(Clone, Debug)]
struct TrailEntry {
    coord_key: String,
    state_key: u32,
}

#[derive(Clone, Debug)]
struct Decision {
    coord_key: String,
    prev_possibilities: IndexSet<u32>,
    trail_start: usize,
    collapse_order_len: usize,
    tried_states: IndexSet<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ConflictInfo {
    pub failed_q: i32,
    pub failed_r: i32,
    pub failed_s: i32,
    pub source_q: Option<i32>,
    pub source_r: Option<i32>,
    pub source_s: Option<i32>,
    pub dir: Option<u8>,
}

#[derive(Clone, Debug)]
pub struct SolveResult {
    pub success: bool,
    pub tiles: Vec<CollapsedTile>,
    pub collapse_order: Vec<CollapsedTile>,
    pub backtracks: u32,
    pub last_conflict: Option<ConflictInfo>,
    pub neighbor_conflict: Option<ConflictInfo>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct CollapsedTile {
    pub q: i32,
    pub r: i32,
    pub s: i32,
    pub tile_id: u16,
    pub rotation: u8,
    pub level: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct TraceState {
    pub tile_id: u16,
    pub rotation: u8,
    pub level: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct TraceCoord {
    pub q: i32,
    pub r: i32,
    pub s: i32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SolveTraceEvent {
    pub step: u32,
    pub kind: &'static str,
    pub rng_calls: u32,
    pub target: Option<TraceCoord>,
    pub chosen: Option<TraceState>,
    pub conflict: Option<ConflictInfo>,
    pub collapse_order_len: usize,
    pub remaining_possibilities: Option<usize>,
    pub available_states: Vec<TraceState>,
    pub tried_states: Vec<TraceState>,
    pub decision_depth: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct WatchedCellSnapshot {
    pub coord: TraceCoord,
    pub is_in_cells: bool,
    pub is_in_fixed: bool,
    pub collapsed: bool,
    pub tile: Option<TraceState>,
    pub possibilities: Vec<TraceState>,
    pub possibility_order: Vec<TraceState>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TraceWatchSnapshot {
    pub step: u32,
    pub cells: Vec<WatchedCellSnapshot>,
}

pub struct Solver<'a, R: RandomSource> {
    rng: &'a mut R,
    mode: WfcMode,
    behavior: SolveBehavior,
    max_backtracks: u32,
    trail: Vec<TrailEntry>,
    decisions: Vec<Decision>,
    collapse_order: Vec<CollapsedTile>,
    backtracks: u32,
    last_conflict: Option<ConflictInfo>,
    neighbor_conflict: Option<ConflictInfo>,
    trace_enabled: bool,
    trace_events: Vec<SolveTraceEvent>,
    trace_step: u32,
    rng_calls: u32,
    watch_steps: HashSet<u32>,
    watch_coords: Vec<CubeCoord>,
    watch_snapshots: Vec<TraceWatchSnapshot>,
}

impl<'a, R: RandomSource> Solver<'a, R> {
    pub fn new(rng: &'a mut R, max_backtracks: u32, mode: WfcMode) -> Self {
        Self {
            rng,
            mode,
            behavior: SolveBehavior::for_mode(mode),
            max_backtracks,
            trail: Vec::new(),
            decisions: Vec::new(),
            collapse_order: Vec::new(),
            backtracks: 0,
            last_conflict: None,
            neighbor_conflict: None,
            trace_enabled: false,
            trace_events: Vec::new(),
            trace_step: 0,
            rng_calls: 0,
            watch_steps: HashSet::new(),
            watch_coords: Vec::new(),
            watch_snapshots: Vec::new(),
        }
    }

    pub fn solve_with_trace(
        &mut self,
        grid: &mut WfcGrid,
        initial_collapses: &[(CubeCoord, TileState)],
    ) -> (SolveResult, Vec<SolveTraceEvent>) {
        let (result, trace, _) =
            self.solve_with_trace_and_watches(grid, initial_collapses, &[], &[]);
        (result, trace)
    }

    pub fn solve_with_trace_and_watches(
        &mut self,
        grid: &mut WfcGrid,
        initial_collapses: &[(CubeCoord, TileState)],
        watch_steps: &[u32],
        watch_coords: &[CubeCoord],
    ) -> (SolveResult, Vec<SolveTraceEvent>, Vec<TraceWatchSnapshot>) {
        self.trace_enabled = true;
        self.watch_steps = watch_steps.iter().copied().collect();
        self.watch_coords = watch_coords.to_vec();
        self.watch_snapshots.clear();
        let result = self.solve(grid, initial_collapses);
        self.trace_enabled = false;
        self.watch_steps.clear();
        self.watch_coords.clear();
        (
            result,
            mem::take(&mut self.trace_events),
            mem::take(&mut self.watch_snapshots),
        )
    }

    pub fn solve(
        &mut self,
        grid: &mut WfcGrid,
        initial_collapses: &[(CubeCoord, TileState)],
    ) -> SolveResult {
        self.trail.clear();
        self.decisions.clear();
        self.collapse_order.clear();
        self.backtracks = 0;
        self.last_conflict = None;
        self.neighbor_conflict = None;
        self.trace_events.clear();
        self.trace_step = 0;
        self.rng_calls = 0;
        self.watch_snapshots.clear();

        if !self.initialize_constraints(grid, initial_collapses) {
            self.neighbor_conflict = self.last_conflict.clone();
            return self.build_result(grid, false);
        }

        if grid.cells.values().any(|cell| cell.possibilities.is_empty()) {
            self.neighbor_conflict = self.last_conflict.clone();
            return self.build_result(grid, false);
        }

        loop {
            let target = match self.find_lowest_entropy(grid) {
                Some(key) => key,
                None => return self.build_result(grid, true),
            };

            let cell = grid.cells.get(&target).unwrap();
            let tried = if self.mode == WfcMode::LegacyCompat {
                None
            } else {
                self.decisions
                    .last()
                    .filter(|decision| decision.coord_key == target)
                    .map(|decision| &decision.tried_states)
            };
            let available = self.available_states_in_order(grid, cell, tried);

            if available.is_empty() {
                if !self.backtrack(grid) {
                    return self.build_result(grid, false);
                }
                continue;
            }

            self.decisions.push(Decision {
                coord_key: target.clone(),
                prev_possibilities: cell.possibilities.clone(),
                trail_start: self.trail.len(),
                collapse_order_len: self.collapse_order.len(),
                tried_states: IndexSet::new(),
            });
            self.record_decision_trace(grid, &target, &available);

            let chosen = self.choose_state(grid, &available);
            self.decisions
                .last_mut()
                .expect("decision just pushed")
                .tried_states
                .insert(chosen.compact_key());

            let cell = grid.cells.get_mut(&target).unwrap();
            let coord = cell.coord;
            cell.collapse(chosen);
            self.collapse_order.push(collapsed_tile(coord, chosen));
            self.record_collapse_trace(grid, coord, chosen);

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

            if !self.propagate(grid, &mut propagation_stack, true) && !self.backtrack(grid) {
                return self.build_result(grid, false);
            }
        }
    }

    fn initialize_constraints(
        &mut self,
        grid: &mut WfcGrid,
        initial_collapses: &[(CubeCoord, TileState)],
    ) -> bool {
        let mut propagation_stack = Vec::new();
        let fixed_keys = grid.fixed_key_order().to_vec();

        if self.mode == WfcMode::LegacyCompat {
            for key in &fixed_keys {
                let Some(state) = grid.fixed_cells.get(key).copied() else {
                    continue;
                };
                if grid.rules.prevents_chaining(state.tile_id)
                    && !self.prune_chaining(grid, key, state.tile_id, &mut propagation_stack, false)
                {
                    return false;
                }
            }
        }

        for (coord, state) in initial_collapses {
            let key = coord.key();
            let Some(cell) = grid.cells.get_mut(&key) else {
                continue;
            };
            if cell.collapsed {
                continue;
            }
            cell.collapse(*state);
            self.collapse_order.push(collapsed_tile(*coord, *state));
            propagation_stack.push(key.clone());

            if self.mode == WfcMode::ModernFast
                && grid.rules.prevents_chaining(state.tile_id)
                && !self.prune_chaining(grid, &key, state.tile_id, &mut propagation_stack, false)
            {
                return false;
            }
        }

        for key in fixed_keys {
            propagation_stack.push(key.clone());
            let Some(state) = grid.fixed_cells.get(&key).copied() else {
                continue;
            };
            if self.mode == WfcMode::ModernFast
                && grid.rules.prevents_chaining(state.tile_id)
                && !self.prune_chaining(grid, &key, state.tile_id, &mut propagation_stack, false)
            {
                return false;
            }
        }

        self.propagate(grid, &mut propagation_stack, false)
    }

    fn available_states_in_order(
        &self,
        _grid: &WfcGrid,
        cell: &crate::grid::WfcCell,
        tried: Option<&IndexSet<u32>>,
    ) -> Vec<u32> {
        match self.mode {
            WfcMode::LegacyCompat => cell
                .possibilities
                .iter()
                .filter(|state_key| tried.is_none_or(|set| !set.contains(*state_key)))
                .copied()
                .collect(),
            WfcMode::ModernFast => {
                let mut available: Vec<u32> = cell
                    .possibilities
                    .iter()
                    .filter(|state_key| tried.is_none_or(|set| !set.contains(*state_key)))
                    .copied()
                    .collect();
                available.sort_unstable();
                available
            }
        }
    }

    fn find_lowest_entropy(&mut self, grid: &WfcGrid) -> Option<String> {
        let mut best_key: Option<&String> = None;
        let mut best_entropy = f64::INFINITY;

        for key in grid.keys_for_mode(self.mode) {
            let cell = &grid.cells[key];
            if cell.collapsed || cell.possibilities.is_empty() {
                continue;
            }

            let entropy = cell.entropy(self.rng.f64());
            self.rng_calls += 1;
            if entropy < best_entropy {
                best_entropy = entropy;
                best_key = Some(key);
            }
        }

        best_key.cloned()
    }

    fn choose_state(&mut self, grid: &WfcGrid, available: &[u32]) -> TileState {
        let weights: Vec<f64> = available
            .iter()
            .map(|&state_key| grid.rules.weight_for_state(state_key))
            .collect();
        let total: f64 = weights.iter().sum();
        let mut r = self.rng.f64() * total;
        self.rng_calls += 1;
        for (index, weight) in weights.iter().enumerate() {
            r -= *weight;
            if r <= 0.0 {
                return compact_to_state(available[index]);
            }
        }
        compact_to_state(available[0])
    }

    fn ordered_possible_states(&self, cell: &crate::grid::WfcCell) -> Vec<u32> {
        match self.mode {
            WfcMode::LegacyCompat => cell.possibilities.iter().copied().collect(),
            WfcMode::ModernFast => cell.possibilities.iter().copied().collect(),
        }
    }

    fn removable_states<F>(&self, cell: &crate::grid::WfcCell, predicate: F) -> Vec<u32>
    where
        F: Fn(u32) -> bool,
    {
        match self.mode {
            WfcMode::LegacyCompat => cell
                .possibilities
                .iter()
                .copied()
                .filter(|state_key| predicate(*state_key))
                .collect(),
            WfcMode::ModernFast => cell
                .possibilities
                .iter()
                .copied()
                .filter(|state_key| predicate(*state_key))
                .collect(),
        }
    }

    fn prune_chaining(
        &mut self,
        grid: &mut WfcGrid,
        key: &str,
        tile_id: u16,
        propagation_stack: &mut Vec<String>,
        record_trail: bool,
    ) -> bool {
        let should_record_trail = record_trail && self.mode == WfcMode::ModernFast;
        let neighbor_keys = match grid.neighbors(key) {
            Some(neighbors) => neighbors.iter().map(|neighbor| neighbor.key.clone()).collect::<Vec<_>>(),
            None => return true,
        };

        for neighbor_key in neighbor_keys {
            let to_remove = match grid.cells.get(&neighbor_key) {
                Some(neighbor) if !neighbor.collapsed =>
                    self.removable_states(neighbor, |state_key| ((state_key >> 16) as u16) == tile_id),
                _ => continue,
            };

            if to_remove.is_empty() {
                if self.mode == WfcMode::LegacyCompat {
                    propagation_stack.push(neighbor_key);
                }
                continue;
            }

            let neighbor_cell = grid.cells.get_mut(&neighbor_key).unwrap();
            for state_key in to_remove {
                if neighbor_cell.remove_possibility(state_key) && should_record_trail {
                    self.trail.push(TrailEntry {
                        coord_key: neighbor_key.clone(),
                        state_key,
                    });
                }
            }

            if neighbor_cell.possibilities.is_empty() {
                if self.behavior.strict_prune_conflicts {
                    self.last_conflict = Some(conflict_from_keys(&neighbor_key, Some(key), None));
                    self.record_conflict_trace(grid, self.last_conflict.clone());
                    return false;
                }
                continue;
            }

            propagation_stack.push(neighbor_key);
        }

        true
    }

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
                    for state_key in self.ordered_possible_states(current_cell) {
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
                    Some(neighbor) if !neighbor.collapsed => {
                        if neighbor.possibilities.is_empty() {
                            self.last_conflict =
                                Some(conflict_from_keys(&neighbor_key, Some(&current_key), Some(dir as u8)));
                            self.record_conflict_trace(grid, self.last_conflict.clone());
                            return false;
                        }
                        self.removable_states(neighbor, |state_key| {
                            !valid_neighbor_states.contains(&state_key)
                        })
                    }
                    _ => continue,
                };

                if to_remove.is_empty() {
                    continue;
                }

                let mut collapsed_state = None;
                {
                    let neighbor_cell = grid.cells.get_mut(&neighbor_key).unwrap();
                    for state_key in to_remove {
                        if neighbor_cell.remove_possibility(state_key) && record_trail {
                            self.trail.push(TrailEntry {
                                coord_key: neighbor_key.clone(),
                                state_key,
                            });
                        }
                    }

                    if neighbor_cell.possibilities.is_empty() {
                        self.last_conflict =
                            Some(conflict_from_keys(&neighbor_key, Some(&current_key), Some(dir as u8)));
                        self.record_conflict_trace(grid, self.last_conflict.clone());
                        return false;
                    }

                    if self.behavior.eager_collapse
                        && !neighbor_cell.collapsed
                        && neighbor_cell.possibilities.len() == 1
                    {
                        let &only_key = neighbor_cell.possibilities.iter().next().unwrap();
                        let state = compact_to_state(only_key);
                        let coord = neighbor_cell.coord;
                        neighbor_cell.collapse(state);
                        collapsed_state = Some((coord, state));
                    }
                }

                if let Some((coord, state)) = collapsed_state {
                    self.collapse_order.push(collapsed_tile(coord, state));
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
        dir: crate::hex::HexDir,
        return_dir: crate::hex::HexDir,
        valid_neighbors: &mut HashSet<u32>,
        looked_up: &mut HashSet<(EdgeType, u8)>,
    ) {
        let (edge_type, edge_level) = grid.rules.state_edges[&state_key][dir.index()];

        if self.behavior.grass_any_level && edge_type == EdgeType::Grass {
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

    fn backtrack(&mut self, grid: &mut WfcGrid) -> bool {
        self.backtracks += 1;
        let hit_limit = if self.behavior.backtrack_limit_is_inclusive {
            self.backtracks >= self.max_backtracks
        } else {
            self.backtracks > self.max_backtracks
        };
        if hit_limit {
            return false;
        }

        let Some(decision) = self.decisions.pop() else {
            return false;
        };

        while self.trail.len() > decision.trail_start {
            let entry = self.trail.pop().unwrap();
            if let Some(cell) = grid.cells.get_mut(&entry.coord_key) {
                cell.add_possibility(entry.state_key);
                if cell.collapsed {
                    cell.collapsed = false;
                    cell.tile = None;
                }
            }
        }

        if let Some(cell) = grid.cells.get_mut(&decision.coord_key) {
            cell.restore_possibilities(decision.prev_possibilities.clone());
            cell.collapsed = false;
            cell.tile = None;
        }

        self.collapse_order.truncate(decision.collapse_order_len);
        let Some(cell) = grid.cells.get(&decision.coord_key) else {
            return false;
        };
        let available = self.available_states_in_order(grid, cell, Some(&decision.tried_states));
        self.record_backtrack_trace(grid, &decision, available.len());
        if available.is_empty() {
            return self.backtrack(grid);
        }

        self.decisions.push(decision);
        true
    }

    fn build_result(&self, grid: &WfcGrid, success: bool) -> SolveResult {
        let tiles = grid
            .cells
            .values()
            .filter_map(|cell| cell.tile.map(|state| collapsed_tile(cell.coord, state)))
            .collect();

        SolveResult {
            success,
            tiles,
            collapse_order: self.collapse_order.clone(),
            backtracks: self.backtracks,
            last_conflict: self.last_conflict.clone(),
            neighbor_conflict: self.neighbor_conflict.clone(),
        }
    }

    fn record_trace(&mut self, mut event: SolveTraceEvent) -> Option<u32> {
        if !self.trace_enabled {
            return None;
        }
        event.step = self.trace_step;
        let step = event.step;
        self.trace_step += 1;
        self.trace_events.push(event);
        Some(step)
    }

    fn record_decision_trace(&mut self, grid: &WfcGrid, target_key: &str, available: &[u32]) {
        let target = trace_coord(parse_cube_key(target_key));
        let step = self.record_trace(SolveTraceEvent {
            step: 0,
            kind: "decision",
            rng_calls: self.rng_calls,
            target: Some(target),
            chosen: None,
            conflict: None,
            collapse_order_len: self.collapse_order.len(),
            remaining_possibilities: Some(available.len()),
            available_states: available.iter().copied().map(trace_state_from_key).collect(),
            tried_states: self
                .decisions
                .last()
                .map(|decision| {
                    decision
                        .tried_states
                        .iter()
                        .copied()
                        .map(trace_state_from_key)
                        .collect()
            })
            .unwrap_or_default(),
            decision_depth: self.decisions.len(),
        });
        if let Some(step) = step {
            self.capture_watch_snapshot(grid, step);
        }
    }

    fn record_collapse_trace(&mut self, grid: &WfcGrid, coord: CubeCoord, state: TileState) {
        let step = self.record_trace(SolveTraceEvent {
            step: 0,
            kind: "collapse",
            rng_calls: self.rng_calls,
            target: Some(trace_coord(coord)),
            chosen: Some(trace_state(state)),
            conflict: None,
            collapse_order_len: self.collapse_order.len(),
            remaining_possibilities: None,
            available_states: Vec::new(),
            tried_states: self
                .decisions
                .last()
                .map(|decision| {
                    decision
                        .tried_states
                        .iter()
                        .copied()
                        .map(trace_state_from_key)
                        .collect()
            })
            .unwrap_or_default(),
            decision_depth: self.decisions.len(),
        });
        if let Some(step) = step {
            self.capture_watch_snapshot(grid, step);
        }
    }

    fn record_conflict_trace(&mut self, grid: &WfcGrid, conflict: Option<ConflictInfo>) {
        let step = self.record_trace(SolveTraceEvent {
            step: 0,
            kind: "conflict",
            rng_calls: self.rng_calls,
            target: conflict.as_ref().map(|info| trace_coord(CubeCoord {
                q: info.failed_q,
                r: info.failed_r,
                s: info.failed_s,
            })),
            chosen: None,
            conflict,
            collapse_order_len: self.collapse_order.len(),
            remaining_possibilities: Some(0),
            available_states: Vec::new(),
            tried_states: Vec::new(),
            decision_depth: self.decisions.len(),
        });
        if let Some(step) = step {
            self.capture_watch_snapshot(grid, step);
        }
    }

    fn record_backtrack_trace(
        &mut self,
        grid: &WfcGrid,
        decision: &Decision,
        remaining_possibilities: usize,
    ) {
        let step = self.record_trace(SolveTraceEvent {
            step: 0,
            kind: "backtrack",
            rng_calls: self.rng_calls,
            target: Some(trace_coord(parse_cube_key(&decision.coord_key))),
            chosen: None,
            conflict: self.last_conflict.clone(),
            collapse_order_len: self.collapse_order.len(),
            remaining_possibilities: Some(remaining_possibilities),
            available_states: Vec::new(),
            tried_states: decision
                .tried_states
                .iter()
                .copied()
                .map(trace_state_from_key)
                .collect(),
            decision_depth: self.decisions.len() + 1,
        });
        if let Some(step) = step {
            self.capture_watch_snapshot(grid, step);
        }
    }

    fn capture_watch_snapshot(&mut self, grid: &WfcGrid, step: u32) {
        if !self.watch_steps.contains(&step) || self.watch_coords.is_empty() {
            return;
        }
        let cells = self
            .watch_coords
            .iter()
            .copied()
            .map(|coord| snapshot_cell(grid, coord))
            .collect();
        self.watch_snapshots.push(TraceWatchSnapshot { step, cells });
    }
}

fn compact_to_state(key: u32) -> TileState {
    TileState {
        tile_id: (key >> 16) as u16,
        rotation: ((key >> 8) & 0xFF) as u8,
        level: (key & 0xFF) as u8,
    }
}

fn trace_state(state: TileState) -> TraceState {
    TraceState {
        tile_id: state.tile_id,
        rotation: state.rotation,
        level: state.level,
    }
}

fn trace_state_from_key(key: u32) -> TraceState {
    trace_state(compact_to_state(key))
}

fn trace_coord(coord: CubeCoord) -> TraceCoord {
    TraceCoord {
        q: coord.q,
        r: coord.r,
        s: coord.s,
    }
}

fn snapshot_cell(grid: &WfcGrid, coord: CubeCoord) -> WatchedCellSnapshot {
    let key = coord.key();
    if let Some(cell) = grid.cells.get(&key) {
        let mut possibilities = cell.possibilities.iter().copied().collect::<Vec<_>>();
        possibilities.sort_unstable();
        let possibility_order = cell.possibilities.iter().copied().collect::<Vec<_>>();
        return WatchedCellSnapshot {
            coord: trace_coord(coord),
            is_in_cells: true,
            is_in_fixed: grid.fixed_cells.contains_key(&key),
            collapsed: cell.collapsed,
            tile: cell.tile.map(trace_state),
            possibilities: possibilities.into_iter().map(trace_state_from_key).collect(),
            possibility_order: possibility_order
                .into_iter()
                .map(trace_state_from_key)
                .collect(),
        };
    }

    if let Some(state) = grid.fixed_state(&key) {
        let fixed_state = trace_state(state);
        return WatchedCellSnapshot {
            coord: trace_coord(coord),
            is_in_cells: false,
            is_in_fixed: true,
            collapsed: true,
            tile: Some(fixed_state),
            possibilities: vec![fixed_state],
            possibility_order: vec![fixed_state],
        };
    }

    WatchedCellSnapshot {
        coord: trace_coord(coord),
        is_in_cells: false,
        is_in_fixed: false,
        collapsed: false,
        tile: None,
        possibilities: Vec::new(),
        possibility_order: Vec::new(),
    }
}

fn collapsed_tile(coord: CubeCoord, state: TileState) -> CollapsedTile {
    CollapsedTile {
        q: coord.q,
        r: coord.r,
        s: coord.s,
        tile_id: state.tile_id,
        rotation: state.rotation,
        level: state.level,
    }
}

fn conflict_from_keys(failed_key: &str, source_key: Option<&str>, dir: Option<u8>) -> ConflictInfo {
    let failed = parse_cube_key(failed_key);
    let source = source_key.map(parse_cube_key);
    ConflictInfo {
        failed_q: failed.q,
        failed_r: failed.r,
        failed_s: failed.s,
        source_q: source.map(|coord| coord.q),
        source_r: source.map(|coord| coord.r),
        source_s: source.map(|coord| coord.s),
        dir,
    }
}

fn parse_cube_key(key: &str) -> CubeCoord {
    let mut parts = key.split(',');
    let q = parts.next().and_then(|part| part.parse().ok()).unwrap_or(0);
    let r = parts.next().and_then(|part| part.parse().ok()).unwrap_or(0);
    CubeCoord::new(q, r)
}
