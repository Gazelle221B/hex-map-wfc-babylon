use std::collections::HashSet;

use js_sys::{Float32Array, Int32Array, Object, Reflect};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

use crate::hex::CubeCoord;
use crate::mode::WfcMode;
use crate::multi_grid::{
    GlobalCellMap, GridSolveResult, LegacyEngineState, LegacyTraceGridResult,
    LegacyTraceSinglePassResult, SinglePassSolveResult, TILE_RADIUS,
    debug_legacy_trace_grid_once, debug_legacy_trace_single_pass_once, get_fixed_cells_for_coords,
    grid_center, solve_all_single_pass, solve_grid_with_mode,
};
use crate::placement::{
    PlacementConfig, PlacementItem, TileInfo, generate_placements, generate_road_buildings,
    generate_windmills,
};
use crate::solver::{CollapsedTile, ConflictInfo, TraceWatchSnapshot};
use crate::tile::{EdgeType, build_tile_list};

const PACKED_GRID_STRIDE: usize = 5;
const PACKED_COORD_STRIDE: usize = 3;
const PACKED_PLACEMENT_STRIDE: usize = 6;

#[derive(Deserialize)]
pub struct SolveOptions {
    pub seed: u64,
    pub grid_q: i32,
    pub grid_r: i32,
    pub tile_types: Option<Vec<u16>>,
    #[serde(default)]
    pub wfc_mode: WfcMode,
    #[serde(default)]
    pub watch_coords: Vec<TraceWatchCoordInput>,
    #[serde(default)]
    pub watch_after_steps: Vec<u32>,
}

#[derive(Deserialize)]
pub struct SolveAllOptions {
    pub seed: u64,
    pub tile_types: Option<Vec<u16>>,
    #[serde(default)]
    pub wfc_mode: WfcMode,
    #[serde(default)]
    pub watch_coords: Vec<TraceWatchCoordInput>,
    #[serde(default)]
    pub watch_after_steps: Vec<u32>,
}

#[derive(Serialize, Clone)]
pub struct JsTile {
    pub q: i32,
    pub r: i32,
    pub s: i32,
    pub tile_id: u16,
    pub rotation: u8,
    pub level: u8,
}

#[derive(Serialize, Clone)]
pub struct JsCoord {
    pub q: i32,
    pub r: i32,
    pub s: i32,
}

#[derive(Serialize)]
pub struct JsSolveResult {
    pub status: String,
    pub success: bool,
    pub tiles: Vec<JsTile>,
    pub collapse_order: Vec<JsTile>,
    pub changed_fixed_cells: Vec<JsTile>,
    pub unfixed_cells: Vec<JsCoord>,
    pub dropped_cells: Vec<JsCoord>,
    pub last_conflict: Option<ConflictInfo>,
    pub neighbor_conflict: Option<ConflictInfo>,
    pub dropped_count: u32,
    pub backtracks: u32,
    pub tries: u32,
    pub local_wfc_attempts: u32,
}

#[derive(Serialize)]
pub struct JsPlacement {
    pub placement_type: u8,
    pub tier: u8,
    pub world_x: f64,
    pub world_y: f64,
    pub world_z: f64,
    pub rotation: f64,
    pub tile_q: i32,
    pub tile_r: i32,
    pub tile_level: u8,
}

#[derive(Serialize)]
pub struct JsLegacyTraceResult {
    pub success: bool,
    pub tiles: Vec<JsTile>,
    pub collapse_order: Vec<JsTile>,
    pub fixed_cells: Vec<JsTile>,
    pub initial_collapses: Vec<JsTile>,
    pub trace: Vec<crate::solver::SolveTraceEvent>,
    pub watched_snapshots: Vec<TraceWatchSnapshot>,
    pub last_conflict: Option<ConflictInfo>,
    pub neighbor_conflict: Option<ConflictInfo>,
    pub backtracks: u32,
    pub tries: u32,
    pub normalized_result: Option<JsSolveResult>,
}

#[derive(Serialize)]
pub struct JsLegacySinglePassTraceResult {
    pub success: bool,
    pub tiles: Vec<JsTile>,
    pub collapse_order: Vec<JsTile>,
    pub fixed_cells: Vec<JsTile>,
    pub initial_collapses: Vec<JsTile>,
    pub trace: Vec<crate::solver::SolveTraceEvent>,
    pub watched_snapshots: Vec<TraceWatchSnapshot>,
    pub last_conflict: Option<ConflictInfo>,
    pub neighbor_conflict: Option<ConflictInfo>,
    pub backtracks: u32,
    pub tries: u32,
    pub normalized_result: Option<JsSolveResult>,
}

#[derive(Deserialize, Clone, Copy)]
pub struct TraceWatchCoordInput {
    pub q: i32,
    pub r: i32,
    pub s: Option<i32>,
}

#[wasm_bindgen]
pub struct WfcEngine {
    global_map: GlobalCellMap,
    tile_defs: Vec<crate::tile::TileDef>,
    legacy_state: Option<LegacyEngineState>,
}

#[wasm_bindgen]
impl WfcEngine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> WfcEngine {
        WfcEngine {
            global_map: GlobalCellMap::new(),
            tile_defs: build_tile_list(),
            legacy_state: None,
        }
    }

    pub fn reset(&mut self) {
        self.global_map = GlobalCellMap::new();
        self.legacy_state = None;
    }

    pub fn solve_grid(&mut self, options: JsValue) -> Result<JsValue, JsValue> {
        let opts: SolveOptions = serde_wasm_bindgen::from_value(options)
            .map_err(|e| JsValue::from_str(&format!("invalid options: {e}")))?;
        let grid_pos = CubeCoord::new(opts.grid_q, opts.grid_r);
        let allowed = opts.tile_types.as_deref();
        let result = self.solve_grid_internal(grid_pos, opts.seed, allowed, opts.wfc_mode);
        serde_wasm_bindgen::to_value(&to_js_solve_result(&result))
            .map_err(|e| JsValue::from_str(&format!("serialization error: {e}")))
    }

    pub fn solve_grid_packed(&mut self, options: JsValue) -> Result<JsValue, JsValue> {
        let opts: SolveOptions = serde_wasm_bindgen::from_value(options)
            .map_err(|e| JsValue::from_str(&format!("invalid options: {e}")))?;
        let grid_pos = CubeCoord::new(opts.grid_q, opts.grid_r);
        let allowed = opts.tile_types.as_deref();
        let result = self.solve_grid_internal(grid_pos, opts.seed, allowed, opts.wfc_mode);
        packed_grid_value(&result)
    }

    pub fn debug_legacy_trace_grid_once(&mut self, options: JsValue) -> Result<JsValue, JsValue> {
        let opts: SolveOptions = serde_wasm_bindgen::from_value(options)
            .map_err(|e| JsValue::from_str(&format!("invalid options: {e}")))?;
        if opts.wfc_mode != WfcMode::LegacyCompat {
            return Err(JsValue::from_str(
                "debug_legacy_trace_grid_once only supports wfc_mode=legacy-compat",
            ));
        }
        if self.legacy_state.is_none() {
            self.legacy_state = Some(LegacyEngineState::new(opts.seed));
        }
        let grid_pos = CubeCoord::new(opts.grid_q, opts.grid_r);
        let allowed = opts.tile_types.as_deref();
        let trace = debug_legacy_trace_grid_once(
            grid_pos,
            &self.global_map,
            opts.seed,
            allowed,
            self.legacy_state.as_ref().expect("legacy state initialized"),
            &opts.watch_after_steps,
            &opts.watch_coords
                .iter()
                .map(trace_watch_coord)
                .collect::<Vec<_>>(),
        );
        serde_wasm_bindgen::to_value(&to_js_legacy_trace_result(&trace))
            .map_err(|e| JsValue::from_str(&format!("serialization error: {e}")))
    }

    pub fn debug_legacy_trace_single_pass_once(
        &mut self,
        options: JsValue,
    ) -> Result<JsValue, JsValue> {
        let opts: SolveAllOptions = serde_wasm_bindgen::from_value(options)
            .map_err(|e| JsValue::from_str(&format!("invalid options: {e}")))?;
        if opts.wfc_mode != WfcMode::LegacyCompat {
            return Err(JsValue::from_str(
                "debug_legacy_trace_single_pass_once only supports wfc_mode=legacy-compat",
            ));
        }
        if self.legacy_state.is_none() {
            self.legacy_state = Some(LegacyEngineState::new(opts.seed));
        }
        let trace = debug_legacy_trace_single_pass_once(
            opts.seed,
            opts.tile_types.as_deref(),
            self.legacy_state.as_ref().expect("legacy state initialized"),
            &opts.watch_after_steps,
            &opts.watch_coords
                .iter()
                .map(trace_watch_coord)
                .collect::<Vec<_>>(),
        );
        serde_wasm_bindgen::to_value(&to_js_legacy_single_pass_trace_result(&trace))
            .map_err(|e| JsValue::from_str(&format!("serialization error: {e}")))
    }

    pub fn solve_all_single_pass(&mut self, options: JsValue) -> Result<JsValue, JsValue> {
        let opts: SolveAllOptions = serde_wasm_bindgen::from_value(options)
            .map_err(|e| JsValue::from_str(&format!("invalid options: {e}")))?;
        if opts.wfc_mode == WfcMode::LegacyCompat && self.legacy_state.is_none() {
            self.legacy_state = Some(LegacyEngineState::new(opts.seed));
        }
        let result = solve_all_single_pass(
            &mut self.global_map,
            opts.seed,
            opts.tile_types.as_deref(),
            opts.wfc_mode,
            self.legacy_state.as_mut(),
        );
        serde_wasm_bindgen::to_value(&to_js_single_pass_result(&result))
            .map_err(|e| JsValue::from_str(&format!("serialization error: {e}")))
    }

    pub fn solve_all_single_pass_packed(&mut self, options: JsValue) -> Result<JsValue, JsValue> {
        let opts: SolveAllOptions = serde_wasm_bindgen::from_value(options)
            .map_err(|e| JsValue::from_str(&format!("invalid options: {e}")))?;
        if opts.wfc_mode == WfcMode::LegacyCompat && self.legacy_state.is_none() {
            self.legacy_state = Some(LegacyEngineState::new(opts.seed));
        }
        let result = solve_all_single_pass(
            &mut self.global_map,
            opts.seed,
            opts.tile_types.as_deref(),
            opts.wfc_mode,
            self.legacy_state.as_mut(),
        );
        packed_single_pass_value(&result)
    }

    pub fn generate_placements(
        &self,
        grid_q: i32,
        grid_r: i32,
        seed: u64,
        offset_x: f64,
        offset_z: f64,
    ) -> Result<JsValue, JsValue> {
        let placements = self.collect_placements(grid_q, grid_r, seed, offset_x, offset_z)?;
        serde_wasm_bindgen::to_value(
            &placements
                .into_iter()
                .map(to_js_placement)
                .collect::<Vec<_>>(),
        )
        .map_err(|e| JsValue::from_str(&format!("serialization error: {e}")))
    }

    pub fn generate_placements_packed(
        &self,
        grid_q: i32,
        grid_r: i32,
        seed: u64,
        offset_x: f64,
        offset_z: f64,
    ) -> Result<Float32Array, JsValue> {
        let placements = self.collect_placements(grid_q, grid_r, seed, offset_x, offset_z)?;
        Ok(Float32Array::from(pack_placements(&placements).as_slice()))
    }

    pub fn global_cell_count(&self) -> usize {
        self.global_map.len()
    }
}

impl WfcEngine {
    fn solve_grid_internal(
        &mut self,
        grid_pos: CubeCoord,
        seed: u64,
        allowed_types: Option<&[u16]>,
        mode: WfcMode,
    ) -> GridSolveResult {
        if mode == WfcMode::LegacyCompat && self.legacy_state.is_none() {
            self.legacy_state = Some(LegacyEngineState::new(seed));
        }
        let result = solve_grid_with_mode(
            grid_pos,
            &self.global_map,
            seed,
            allowed_types,
            mode,
            self.legacy_state.as_mut(),
        );
        self.apply_grid_result(grid_pos, &result);
        result
    }

    fn apply_grid_result(&mut self, grid_pos: CubeCoord, result: &GridSolveResult) {
        for changed in &result.changed_fixed_cells {
            let key = tile_coord(*changed).key();
            if let Some(existing) = self.global_map.get_mut(&key) {
                existing.tile_id = changed.tile_id;
                existing.rotation = changed.rotation;
                existing.level = changed.level;
            }
        }
        for changed in &result.persisted_replacements {
            let key = tile_coord(*changed).key();
            if let Some(existing) = self.global_map.get_mut(&key) {
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
        self.global_map.remove_grid(&grid_key);
        self.global_map.insert_result(&filtered, &grid_key);
    }

    fn collect_placements(
        &self,
        grid_q: i32,
        grid_r: i32,
        seed: u64,
        offset_x: f64,
        offset_z: f64,
    ) -> Result<Vec<PlacementItem>, JsValue> {
        let grid_pos = CubeCoord::new(grid_q, grid_r);
        let center = grid_center(grid_pos, TILE_RADIUS);
        let local_coords = center.cells_in_radius(TILE_RADIUS);
        let fixed_cells = get_fixed_cells_for_coords(&local_coords, &self.global_map);
        let fixed_set = fixed_cells
            .iter()
            .map(|tile| tile_coord(*tile).key())
            .collect::<HashSet<_>>();

        let tile_infos: Vec<TileInfo> = local_coords
            .iter()
            .filter_map(|coord| {
                let key = coord.key();
                if fixed_set.contains(&key) {
                    return None;
                }
                let cell = self.global_map.get(&key)?;
                let tile_def = &self.tile_defs[cell.tile_id as usize];
                let is_grass = tile_def.edges.iter().all(|edge| *edge == EdgeType::Grass);
                let road_edges = tile_def
                    .edges
                    .iter()
                    .filter(|edge| **edge == EdgeType::Road)
                    .count();
                Some(TileInfo {
                    coord: *coord,
                    tile_id: cell.tile_id,
                    rotation: cell.rotation,
                    level: cell.level,
                    is_grass,
                    is_road_dead_end: road_edges == 1,
                    is_coast_adjacent: tile_def.edges.iter().any(|edge| *edge == EdgeType::Coast),
                    has_river: tile_def.edges.iter().any(|edge| *edge == EdgeType::River),
                })
            })
            .collect();

        let config = PlacementConfig::default();
        let mut placements = Vec::new();
        placements.extend(generate_placements(&tile_infos, &config, seed, offset_x, offset_z));
        placements.extend(generate_road_buildings(&tile_infos, seed));
        placements.extend(generate_windmills(&tile_infos, seed));
        Ok(placements)
    }
}

fn to_js_solve_result(result: &GridSolveResult) -> JsSolveResult {
    JsSolveResult {
        status: result.status.as_str().to_string(),
        success: result.success,
        tiles: result.tiles.iter().map(to_js_tile).collect(),
        collapse_order: result.collapse_order.iter().map(to_js_tile).collect(),
        changed_fixed_cells: result.changed_fixed_cells.iter().map(to_js_tile).collect(),
        unfixed_cells: result.unfixed_cells.iter().map(to_js_coord).collect(),
        dropped_cells: result.dropped_cubes.iter().map(to_js_coord).collect(),
        last_conflict: result.last_conflict.clone(),
        neighbor_conflict: result.neighbor_conflict.clone(),
        dropped_count: result.stats.dropped_count,
        backtracks: result.stats.backtracks,
        tries: result.stats.tries,
        local_wfc_attempts: result.stats.local_wfc_attempts,
    }
}

fn to_js_single_pass_result(result: &SinglePassSolveResult) -> JsSolveResult {
    JsSolveResult {
        status: result.status.as_str().to_string(),
        success: result.success,
        tiles: result.tiles.iter().map(to_js_tile).collect(),
        collapse_order: result.collapse_order.iter().map(to_js_tile).collect(),
        changed_fixed_cells: Vec::new(),
        unfixed_cells: Vec::new(),
        dropped_cells: Vec::new(),
        last_conflict: result.last_conflict.clone(),
        neighbor_conflict: result.neighbor_conflict.clone(),
        dropped_count: result.stats.dropped_count,
        backtracks: result.stats.backtracks,
        tries: result.stats.tries,
        local_wfc_attempts: result.stats.local_wfc_attempts,
    }
}

fn to_js_tile(tile: &CollapsedTile) -> JsTile {
    JsTile {
        q: tile.q,
        r: tile.r,
        s: tile.s,
        tile_id: tile.tile_id,
        rotation: tile.rotation,
        level: tile.level,
    }
}

fn to_js_coord(coord: &CubeCoord) -> JsCoord {
    JsCoord {
        q: coord.q,
        r: coord.r,
        s: coord.s,
    }
}

fn to_js_placement(placement: PlacementItem) -> JsPlacement {
    JsPlacement {
        placement_type: placement.placement_type as u8,
        tier: placement.tier,
        world_x: placement.world_x,
        world_y: placement.world_y,
        world_z: placement.world_z,
        rotation: placement.rotation,
        tile_q: placement.tile_q,
        tile_r: placement.tile_r,
        tile_level: placement.tile_level,
    }
}

fn to_js_legacy_trace_result(result: &LegacyTraceGridResult) -> JsLegacyTraceResult {
    JsLegacyTraceResult {
        success: result.success,
        tiles: result.tiles.iter().map(to_js_tile).collect(),
        collapse_order: result.collapse_order.iter().map(to_js_tile).collect(),
        fixed_cells: result.fixed_cells.iter().map(to_js_tile).collect(),
        initial_collapses: result.initial_collapses.iter().map(to_js_tile).collect(),
        trace: result.trace.clone(),
        watched_snapshots: result.watched_snapshots.clone(),
        last_conflict: result.last_conflict.clone(),
        neighbor_conflict: result.neighbor_conflict.clone(),
        backtracks: result.backtracks,
        tries: result.tries,
        normalized_result: result.normalized_result.as_ref().map(to_js_solve_result),
    }
}

fn to_js_legacy_single_pass_trace_result(
    result: &LegacyTraceSinglePassResult,
) -> JsLegacySinglePassTraceResult {
    JsLegacySinglePassTraceResult {
        success: result.success,
        tiles: result.tiles.iter().map(to_js_tile).collect(),
        collapse_order: result.collapse_order.iter().map(to_js_tile).collect(),
        fixed_cells: result.fixed_cells.iter().map(to_js_tile).collect(),
        initial_collapses: result.initial_collapses.iter().map(to_js_tile).collect(),
        trace: result.trace.clone(),
        watched_snapshots: result.watched_snapshots.clone(),
        last_conflict: result.last_conflict.clone(),
        neighbor_conflict: result.neighbor_conflict.clone(),
        backtracks: result.backtracks,
        tries: result.tries,
        normalized_result: result.normalized_result.as_ref().map(to_js_single_pass_result),
    }
}

fn trace_watch_coord(input: &TraceWatchCoordInput) -> CubeCoord {
    let coord = CubeCoord::new(input.q, input.r);
    if let Some(s) = input.s {
        debug_assert_eq!(coord.s, s);
    }
    coord
}

fn packed_grid_value(result: &GridSolveResult) -> Result<JsValue, JsValue> {
    let object = Object::new();
    set_field(&object, "status", &JsValue::from_str(result.status.as_str()))?;
    set_field(&object, "cells", &Int32Array::from(pack_tiles(&result.tiles).as_slice()).into())?;
    set_field(
        &object,
        "collapse_order",
        &Int32Array::from(pack_tiles(&result.collapse_order).as_slice()).into(),
    )?;
    set_field(
        &object,
        "changed_fixed_cells",
        &Int32Array::from(pack_tiles(&result.changed_fixed_cells).as_slice()).into(),
    )?;
    set_field(
        &object,
        "unfixed_cells",
        &Int32Array::from(pack_coords(&result.unfixed_cells).as_slice()).into(),
    )?;
    set_field(
        &object,
        "dropped_cells",
        &Int32Array::from(pack_coords(&result.dropped_cubes).as_slice()).into(),
    )?;
    set_field(
        &object,
        "backtracks",
        &JsValue::from_f64(result.stats.backtracks as f64),
    )?;
    set_field(&object, "tries", &JsValue::from_f64(result.stats.tries as f64))?;
    set_field(
        &object,
        "local_wfc_attempts",
        &JsValue::from_f64(result.stats.local_wfc_attempts as f64),
    )?;
    set_field(
        &object,
        "dropped_count",
        &JsValue::from_f64(result.stats.dropped_count as f64),
    )?;
    set_optional_field(&object, "last_conflict", result.last_conflict.as_ref())?;
    set_optional_field(
        &object,
        "neighbor_conflict",
        result.neighbor_conflict.as_ref(),
    )?;
    Ok(object.into())
}

fn packed_single_pass_value(result: &SinglePassSolveResult) -> Result<JsValue, JsValue> {
    let object = Object::new();
    set_field(&object, "status", &JsValue::from_str(result.status.as_str()))?;
    set_field(&object, "cells", &Int32Array::from(pack_tiles(&result.tiles).as_slice()).into())?;
    set_field(
        &object,
        "collapse_order",
        &Int32Array::from(pack_tiles(&result.collapse_order).as_slice()).into(),
    )?;
    set_field(
        &object,
        "backtracks",
        &JsValue::from_f64(result.stats.backtracks as f64),
    )?;
    set_field(&object, "tries", &JsValue::from_f64(result.stats.tries as f64))?;
    set_optional_field(&object, "last_conflict", result.last_conflict.as_ref())?;
    set_optional_field(
        &object,
        "neighbor_conflict",
        result.neighbor_conflict.as_ref(),
    )?;
    Ok(object.into())
}

fn set_field(target: &Object, key: &str, value: &JsValue) -> Result<(), JsValue> {
    Reflect::set(target, &JsValue::from_str(key), value)
        .map(|_| ())
        .map_err(JsValue::from)
}

fn set_optional_field<T: Serialize>(
    target: &Object,
    key: &str,
    value: Option<&T>,
) -> Result<(), JsValue> {
    let js_value = match value {
        Some(value) => serde_wasm_bindgen::to_value(value)
            .map_err(|e| JsValue::from_str(&format!("serialization error: {e}")))?,
        None => JsValue::NULL,
    };
    set_field(target, key, &js_value)
}

fn pack_tiles(tiles: &[CollapsedTile]) -> Vec<i32> {
    let mut packed = Vec::with_capacity(tiles.len() * PACKED_GRID_STRIDE);
    for tile in tiles {
        packed.push(tile.q);
        packed.push(tile.r);
        packed.push(tile.tile_id as i32);
        packed.push(tile.rotation as i32);
        packed.push(tile.level as i32);
    }
    packed
}

fn pack_coords(coords: &[CubeCoord]) -> Vec<i32> {
    let mut packed = Vec::with_capacity(coords.len() * PACKED_COORD_STRIDE);
    for coord in coords {
        packed.push(coord.q);
        packed.push(coord.r);
        packed.push(coord.s);
    }
    packed
}

fn pack_placements(placements: &[PlacementItem]) -> Vec<f32> {
    let mut packed = Vec::with_capacity(placements.len() * PACKED_PLACEMENT_STRIDE);
    for item in placements {
        packed.push(item.placement_type as u8 as f32);
        packed.push(item.tier as f32);
        packed.push(item.world_x as f32);
        packed.push(item.world_y as f32);
        packed.push(item.world_z as f32);
        packed.push(item.rotation as f32);
    }
    packed
}

fn tile_coord(tile: CollapsedTile) -> CubeCoord {
    CubeCoord::new(tile.q, tile.r)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::multi_grid::{GridSolveStatus, solve_grid};

    #[test]
    fn packed_tiles_have_expected_stride() {
        let result = solve_grid(CubeCoord::new(0, 0), &GlobalCellMap::new(), 42, None);
        assert_eq!(pack_tiles(&result.tiles).len(), result.tiles.len() * PACKED_GRID_STRIDE);
    }

    #[test]
    fn packed_coords_have_expected_stride() {
        let coords = vec![CubeCoord::new(0, 0), CubeCoord::new(1, -1)];
        assert_eq!(pack_coords(&coords).len(), coords.len() * PACKED_COORD_STRIDE);
    }

    #[test]
    fn fallback_water_result_packs_tiles() {
        let result = solve_grid(CubeCoord::new(0, 0), &GlobalCellMap::new(), 42, Some(&[]));
        assert_eq!(result.status, GridSolveStatus::FallbackWater);
    }
}
