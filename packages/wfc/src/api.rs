use js_sys::{Float32Array, Int32Array, Object, Reflect};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

use crate::hex::CubeCoord;
use crate::multi_grid::{
    GlobalCellMap, GridSolveResult, TILE_RADIUS, all_grid_positions, grid_center, local_to_global,
    solve_grid,
};
use crate::placement::{
    PlacementConfig, PlacementItem, TileInfo, generate_placements, generate_road_buildings,
    generate_windmills,
};
use crate::solver::CollapsedTile;
use crate::tile::{EdgeType, build_tile_list};

const PACKED_GRID_STRIDE: usize = 5;
const PACKED_PLACEMENT_STRIDE: usize = 6;

/// JS-friendly solve options.
#[derive(Deserialize)]
pub struct SolveOptions {
    pub seed: u64,
    pub grid_q: i32,
    pub grid_r: i32,
    pub tile_types: Option<Vec<u16>>,
}

/// JS-friendly collapsed tile.
#[derive(Serialize, Clone)]
pub struct JsTile {
    pub q: i32,
    pub r: i32,
    pub s: i32,
    pub tile_id: u16,
    pub rotation: u8,
    pub level: u8,
}

/// JS-friendly solve result.
#[derive(Serialize)]
pub struct JsSolveResult {
    pub success: bool,
    pub tiles: Vec<JsTile>,
    pub collapse_order: Vec<JsTile>,
    pub changed_fixed_cells: Vec<JsTile>,
    pub dropped_count: u32,
    pub backtracks: u32,
    pub tries: u32,
    pub local_wfc_attempts: u32,
}

/// JS-friendly placement item.
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

/// The WFC engine, holding global state across multiple grid solves.
#[wasm_bindgen]
pub struct WfcEngine {
    global_map: GlobalCellMap,
    tile_defs: Vec<crate::tile::TileDef>,
}

#[wasm_bindgen]
impl WfcEngine {
    /// Create a new WFC engine.
    #[wasm_bindgen(constructor)]
    pub fn new() -> WfcEngine {
        WfcEngine {
            global_map: GlobalCellMap::new(),
            tile_defs: build_tile_list(),
        }
    }

    /// Reset the engine, clearing all global state.
    pub fn reset(&mut self) {
        self.global_map = GlobalCellMap::new();
    }

    /// Solve a single grid at the given position.
    /// Returns a JsSolveResult via serde_wasm_bindgen.
    pub fn solve_grid(&mut self, options: JsValue) -> Result<JsValue, JsValue> {
        let opts: SolveOptions = serde_wasm_bindgen::from_value(options)
            .map_err(|e| JsValue::from_str(&format!("invalid options: {e}")))?;

        let grid_pos = CubeCoord::new(opts.grid_q, opts.grid_r);
        let allowed = opts.tile_types.as_deref();

        let result = solve_grid(grid_pos, &self.global_map, opts.seed, allowed);

        if result.success {
            let grid_key = grid_pos.key();
            // Remove old data for this grid before inserting new
            self.global_map.remove_grid(&grid_key);
            self.global_map.insert_result(&result.tiles, &grid_key);
        }

        let js_result = JsSolveResult {
            success: result.success,
            tiles: result.tiles.iter().map(to_js_tile).collect(),
            collapse_order: result.collapse_order.iter().map(to_js_tile).collect(),
            changed_fixed_cells: result.changed_fixed_cells.iter().map(to_js_tile).collect(),
            dropped_count: result.stats.dropped_count,
            backtracks: result.stats.backtracks,
            tries: result.stats.tries,
            local_wfc_attempts: result.stats.local_wfc_attempts,
        };

        serde_wasm_bindgen::to_value(&js_result)
            .map_err(|e| JsValue::from_str(&format!("serialization error: {e}")))
    }

    /// Solve a single grid and return a packed cell buffer plus metadata.
    pub fn solve_grid_packed(&mut self, options: JsValue) -> Result<JsValue, JsValue> {
        let opts: SolveOptions = serde_wasm_bindgen::from_value(options)
            .map_err(|e| JsValue::from_str(&format!("invalid options: {e}")))?;

        let grid_pos = CubeCoord::new(opts.grid_q, opts.grid_r);
        let allowed = opts.tile_types.as_deref();
        let result = solve_grid(grid_pos, &self.global_map, opts.seed, allowed);

        if result.success {
            let grid_key = grid_pos.key();
            self.global_map.remove_grid(&grid_key);
            self.global_map.insert_result(&result.tiles, &grid_key);
        }

        packed_solve_value(&result)
    }

    /// Solve all 19 grids in order (center first, then outward).
    /// Returns an array of JsSolveResult.
    pub fn solve_all(&mut self, seed: u64) -> Result<JsValue, JsValue> {
        self.reset();
        let mut results = Vec::new();

        // all_grid_positions() defines the canonical cross-language grid order.
        let positions = all_grid_positions();

        for (i, pos) in positions.iter().enumerate() {
            let result = solve_grid(*pos, &self.global_map, seed + i as u64, None);

            if result.success {
                let grid_key = pos.key();
                self.global_map.insert_result(&result.tiles, &grid_key);
            }

            results.push(JsSolveResult {
                success: result.success,
                tiles: result.tiles.iter().map(to_js_tile).collect(),
                collapse_order: result.collapse_order.iter().map(to_js_tile).collect(),
                changed_fixed_cells: result.changed_fixed_cells.iter().map(to_js_tile).collect(),
                dropped_count: result.stats.dropped_count,
                backtracks: result.stats.backtracks,
                tries: result.stats.tries,
                local_wfc_attempts: result.stats.local_wfc_attempts,
            });
        }

        serde_wasm_bindgen::to_value(&results)
            .map_err(|e| JsValue::from_str(&format!("serialization error: {e}")))
    }

    /// Generate placements for a solved grid.
    pub fn generate_placements(
        &self,
        grid_q: i32,
        grid_r: i32,
        seed: u64,
        offset_x: f64,
        offset_z: f64,
    ) -> Result<JsValue, JsValue> {
        let grid_pos = CubeCoord::new(grid_q, grid_r);
        let center = grid_center(grid_pos, TILE_RADIUS);

        // Collect tile info from the global map for this grid
        let local_coords = CubeCoord::new(0, 0).cells_in_radius(TILE_RADIUS);
        let tile_infos: Vec<TileInfo> = local_coords
            .iter()
            .filter_map(|&local| {
                let global = local_to_global(local, center);
                let cell = self.global_map.get(&global.key())?;
                let tile_def = &self.tile_defs[cell.tile_id as usize];
                let is_grass = tile_def.edges.iter().all(|e| *e == EdgeType::Grass);
                let road_edges: usize = tile_def
                    .edges
                    .iter()
                    .filter(|e| **e == EdgeType::Road)
                    .count();

                Some(TileInfo {
                    coord: global,
                    tile_id: cell.tile_id,
                    rotation: cell.rotation,
                    level: cell.level,
                    is_grass,
                    is_road_dead_end: road_edges == 1,
                    is_coast_adjacent: tile_def.edges.iter().any(|e| *e == EdgeType::Coast),
                    has_river: tile_def.edges.iter().any(|e| *e == EdgeType::River),
                })
            })
            .collect();

        let config = PlacementConfig::default();
        let mut all_placements = Vec::new();

        all_placements.extend(
            generate_placements(&tile_infos, &config, seed, offset_x, offset_z)
                .into_iter()
                .map(to_js_placement),
        );
        all_placements.extend(
            generate_road_buildings(&tile_infos, seed)
                .into_iter()
                .map(to_js_placement),
        );
        all_placements.extend(
            generate_windmills(&tile_infos, seed)
                .into_iter()
                .map(to_js_placement),
        );

        serde_wasm_bindgen::to_value(&all_placements)
            .map_err(|e| JsValue::from_str(&format!("serialization error: {e}")))
    }

    /// Generate packed placements for a solved grid.
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

    /// Get the number of cells in the global map.
    pub fn global_cell_count(&self) -> usize {
        self.global_map.len()
    }
}

impl WfcEngine {
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

        let local_coords = CubeCoord::new(0, 0).cells_in_radius(TILE_RADIUS);
        let tile_infos: Vec<TileInfo> = local_coords
            .iter()
            .filter_map(|&local| {
                let global = local_to_global(local, center);
                let cell = self.global_map.get(&global.key())?;
                let tile_def = &self.tile_defs[cell.tile_id as usize];
                let is_grass = tile_def.edges.iter().all(|e| *e == EdgeType::Grass);
                let road_edges: usize = tile_def
                    .edges
                    .iter()
                    .filter(|e| **e == EdgeType::Road)
                    .count();

                Some(TileInfo {
                    coord: global,
                    tile_id: cell.tile_id,
                    rotation: cell.rotation,
                    level: cell.level,
                    is_grass,
                    is_road_dead_end: road_edges == 1,
                    is_coast_adjacent: tile_def.edges.iter().any(|e| *e == EdgeType::Coast),
                    has_river: tile_def.edges.iter().any(|e| *e == EdgeType::River),
                })
            })
            .collect();

        let config = PlacementConfig::default();
        let mut all_placements = Vec::new();

        all_placements.extend(generate_placements(
            &tile_infos,
            &config,
            seed,
            offset_x,
            offset_z,
        ));
        all_placements.extend(generate_road_buildings(&tile_infos, seed));
        all_placements.extend(generate_windmills(&tile_infos, seed));

        Ok(all_placements)
    }
}

fn to_js_tile(t: &CollapsedTile) -> JsTile {
    JsTile {
        q: t.q,
        r: t.r,
        s: t.s,
        tile_id: t.tile_id,
        rotation: t.rotation,
        level: t.level,
    }
}

fn to_js_placement(p: PlacementItem) -> JsPlacement {
    JsPlacement {
        placement_type: p.placement_type as u8,
        tier: p.tier,
        world_x: p.world_x,
        world_y: p.world_y,
        world_z: p.world_z,
        rotation: p.rotation,
        tile_q: p.tile_q,
        tile_r: p.tile_r,
        tile_level: p.tile_level,
    }
}

fn packed_solve_value(result: &GridSolveResult) -> Result<JsValue, JsValue> {
    let object = Object::new();
    let cells = Int32Array::from(pack_tiles(&result.tiles).as_slice());

    set_field(&object, "status", &JsValue::from_str(result.status.as_str()))?;
    set_field(&object, "cells", &cells.into())?;
    set_field(
        &object,
        "dropped_count",
        &JsValue::from_f64(result.stats.dropped_count as f64),
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

    Ok(object.into())
}

fn set_field(target: &Object, key: &str, value: &JsValue) -> Result<(), JsValue> {
    Reflect::set(target, &JsValue::from_str(key), value)
        .map(|_| ())
        .map_err(|e| JsValue::from(e))
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::multi_grid::{GridSolveStatus, solve_grid};

    #[test]
    fn packed_tiles_have_expected_stride() {
        let result = solve_grid(CubeCoord::new(0, 0), &GlobalCellMap::new(), 42, None);
        let packed = pack_tiles(&result.tiles);
        assert_eq!(packed.len(), result.tiles.len() * PACKED_GRID_STRIDE);
    }

    #[test]
    fn packed_placements_have_expected_stride() {
        let placements = vec![
            PlacementItem {
                placement_type: crate::placement::PlacementType::TreeA,
                tier: 2,
                world_x: 1.0,
                world_y: 2.0,
                world_z: 3.0,
                rotation: 4.0,
                tile_q: 0,
                tile_r: 0,
                tile_level: 1,
            },
            PlacementItem {
                placement_type: crate::placement::PlacementType::Windmill,
                tier: 0,
                world_x: 5.0,
                world_y: 6.0,
                world_z: 7.0,
                rotation: 8.0,
                tile_q: 1,
                tile_r: -1,
                tile_level: 0,
            },
        ];

        let packed = pack_placements(&placements);
        assert_eq!(packed.len(), placements.len() * PACKED_PLACEMENT_STRIDE);
        assert_eq!(packed[0], 0.0);
        assert_eq!(packed[1], 2.0);
        assert_eq!(packed[PACKED_PLACEMENT_STRIDE], 3.0);
    }

    #[test]
    fn fallback_water_result_packs_tiles() {
        let result = solve_grid(CubeCoord::new(0, 0), &GlobalCellMap::new(), 42, Some(&[]));
        assert_eq!(result.status, GridSolveStatus::FallbackWater);
        let packed = pack_tiles(&result.tiles);
        assert_eq!(packed.len(), result.tiles.len() * PACKED_GRID_STRIDE);
        assert_eq!(packed[2], 1);
        assert_eq!(packed[3], 0);
        assert_eq!(packed[4], 0);
    }
}
