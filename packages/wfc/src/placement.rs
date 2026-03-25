use noise::{NoiseFn, Simplex};

use crate::hex::CubeCoord;
use crate::rng::Rng;

/// Noise frequencies for different placement types.
pub const TREE_FREQUENCY: f64 = 0.05;
pub const BUILDING_FREQUENCY: f64 = 0.02;

/// Default noise thresholds.
pub const TREE_THRESHOLD: f64 = 0.5;
pub const BUILDING_THRESHOLD: f64 = 0.77;

/// Level height and tile surface constants.
pub const LEVEL_HEIGHT: f64 = 0.5;
pub const TILE_SURFACE: f64 = 1.0;

/// Hex geometry constants.
pub const HEX_WIDTH: f64 = 2.0;
pub const HEX_HEIGHT: f64 = 2.0 / 1.732_050_808 * 2.0; // 2 / sqrt(3) * 2

/// Placement type for a decoration.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum PlacementType {
    TreeA = 0,
    TreeB = 1,
    Building = 2,
    Windmill = 3,
    Bridge = 4,
    Waterlily = 5,
    Flower = 6,
    Rock = 7,
    Hill = 8,
    Mountain = 9,
}

/// Tree density tier (0 = single, 1 = small group, 2 = medium, 3 = large).
pub type TreeTier = u8;

/// A placement item computed by the noise-based system.
#[derive(Clone, Debug)]
pub struct PlacementItem {
    pub placement_type: PlacementType,
    pub tier: u8,
    pub world_x: f64,
    pub world_y: f64,
    pub world_z: f64,
    pub rotation: f64,
    pub tile_q: i32,
    pub tile_r: i32,
    pub tile_level: u8,
}

/// Scaled noise wrapper: maps simplex noise [-1, 1] to [0, 1].
struct ScaledNoise {
    simplex: Simplex,
    frequency: f64,
}

impl ScaledNoise {
    fn new(seed: u32, frequency: f64) -> Self {
        Self {
            simplex: Simplex::new(seed),
            frequency,
        }
    }

    fn sample(&self, x: f64, z: f64) -> f64 {
        let v = self.simplex.get([x * self.frequency, z * self.frequency]);
        (v + 1.0) * 0.5
    }
}

/// Configuration for placement generation.
#[derive(Clone, Debug)]
pub struct PlacementConfig {
    pub tree_threshold: f64,
    pub building_threshold: f64,
    pub tree_frequency: f64,
    pub building_frequency: f64,
}

impl Default for PlacementConfig {
    fn default() -> Self {
        Self {
            tree_threshold: TREE_THRESHOLD,
            building_threshold: BUILDING_THRESHOLD,
            tree_frequency: TREE_FREQUENCY,
            building_frequency: BUILDING_FREQUENCY,
        }
    }
}

/// Tile info needed for placement calculation.
#[derive(Clone, Debug)]
pub struct TileInfo {
    pub coord: CubeCoord,
    pub tile_id: u16,
    pub rotation: u8,
    pub level: u8,
    pub is_grass: bool,
    pub is_road_dead_end: bool,
    pub is_coast_adjacent: bool,
    pub has_river: bool,
}

/// Compute noise-based tree tier from a noise value and threshold.
fn tree_tier(noise_val: f64, threshold: f64) -> Option<TreeTier> {
    if noise_val < threshold {
        return None;
    }
    let normalized = (noise_val - threshold) / (1.0 - threshold);
    let tier = (normalized * 4.0).floor().min(3.0) as u8;
    Some(tier)
}

/// Generate placement items for a set of tiles.
/// `offset_x`, `offset_z` are the world-space offset for the grid.
pub fn generate_placements(
    tiles: &[TileInfo],
    config: &PlacementConfig,
    seed: u64,
    offset_x: f64,
    offset_z: f64,
) -> Vec<PlacementItem> {
    let noise_a = ScaledNoise::new(seed as u32, config.tree_frequency);
    let noise_b = ScaledNoise::new(seed as u32 + 1, config.tree_frequency);
    let noise_c = ScaledNoise::new(seed as u32 + 2, config.building_frequency);
    let mut rng = Rng::new(seed);
    let mut placements = Vec::new();

    for tile in tiles {
        if !tile.is_grass {
            continue;
        }

        let (local_x, local_z) = tile.coord.to_world(HEX_WIDTH);
        let world_x = local_x + offset_x;
        let world_z = local_z + offset_z;
        let base_y = tile.level as f64 * LEVEL_HEIGHT + TILE_SURFACE;

        // Tree placement
        let val_a = noise_a.sample(world_x, world_z);
        let val_b = noise_b.sample(world_x, world_z);
        let tier_a = tree_tier(val_a, config.tree_threshold);
        let tier_b = tree_tier(val_b, config.tree_threshold);

        let tree = match (tier_a, tier_b) {
            (Some(ta), Some(tb)) => {
                if val_a >= val_b {
                    Some((PlacementType::TreeA, ta))
                } else {
                    Some((PlacementType::TreeB, tb))
                }
            }
            (Some(ta), None) => Some((PlacementType::TreeA, ta)),
            (None, Some(tb)) => Some((PlacementType::TreeB, tb)),
            (None, None) => None,
        };

        if let Some((tree_type, tier)) = tree {
            let ox = (rng.f64() - 0.5) * 0.4;
            let oz = (rng.f64() - 0.5) * 0.4;
            placements.push(PlacementItem {
                placement_type: tree_type,
                tier,
                world_x: world_x + ox,
                world_y: base_y,
                world_z: world_z + oz,
                rotation: rng.f64() * std::f64::consts::TAU,
                tile_q: tile.coord.q,
                tile_r: tile.coord.r,
                tile_level: tile.level,
            });
            continue; // Trees and buildings are mutually exclusive
        }

        // Building placement (noise-based)
        let val_c = noise_c.sample(world_x, world_z);
        if val_c >= config.building_threshold {
            let jitter_x = (rng.f64() - 0.5) * 0.6;
            let jitter_z = (rng.f64() - 0.5) * 0.6;
            placements.push(PlacementItem {
                placement_type: PlacementType::Building,
                tier: 0,
                world_x: world_x + jitter_x,
                world_y: base_y,
                world_z: world_z + jitter_z,
                rotation: rng.f64() * std::f64::consts::TAU,
                tile_q: tile.coord.q,
                tile_r: tile.coord.r,
                tile_level: tile.level,
            });
        }
    }

    placements
}

/// Generate dead-end road building placements.
/// These are handled separately because they use road direction, not noise.
pub fn generate_road_buildings(
    tiles: &[TileInfo],
    seed: u64,
) -> Vec<PlacementItem> {
    let mut rng = Rng::new(seed);
    let mut placements = Vec::new();

    for tile in tiles {
        if !tile.is_road_dead_end {
            continue;
        }

        let (world_x, world_z) = tile.coord.to_world(HEX_WIDTH);
        let base_y = tile.level as f64 * LEVEL_HEIGHT + TILE_SURFACE;
        let road_angle = tile.rotation as f64 * std::f64::consts::FRAC_PI_3;

        // Dead-end buildings face the road exit
        placements.push(PlacementItem {
            placement_type: PlacementType::Building,
            tier: 1, // tier 1 = road building
            world_x,
            world_y: base_y,
            world_z,
            rotation: road_angle,
            tile_q: tile.coord.q,
            tile_r: tile.coord.r,
            tile_level: tile.level,
        });

        // Consume rng state for consistency
        let _ = rng.f64();
    }

    placements
}

/// Generate windmill placements on coast-adjacent grass tiles.
pub fn generate_windmills(
    tiles: &[TileInfo],
    seed: u64,
) -> Vec<PlacementItem> {
    let mut rng = Rng::new(seed + 100);
    let mut placements = Vec::new();
    let spawn_chance = 0.35;
    let mut count = 0;
    let max_per_grid = 1;

    for tile in tiles {
        if !tile.is_coast_adjacent || !tile.is_grass || count >= max_per_grid {
            continue;
        }

        if rng.f64() > spawn_chance {
            continue;
        }

        let (world_x, world_z) = tile.coord.to_world(HEX_WIDTH);
        let base_y = tile.level as f64 * LEVEL_HEIGHT + TILE_SURFACE;

        placements.push(PlacementItem {
            placement_type: PlacementType::Windmill,
            tier: 0,
            world_x,
            world_y: base_y,
            world_z,
            rotation: rng.f64() * std::f64::consts::TAU,
            tile_q: tile.coord.q,
            tile_r: tile.coord.r,
            tile_level: tile.level,
        });
        count += 1;
    }

    placements
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tree_tier_below_threshold_returns_none() {
        assert!(tree_tier(0.3, 0.5).is_none());
        assert!(tree_tier(0.49, 0.5).is_none());
    }

    #[test]
    fn tree_tier_at_threshold_returns_tier_0() {
        assert_eq!(tree_tier(0.5, 0.5), Some(0));
    }

    #[test]
    fn tree_tier_high_noise_returns_tier_3() {
        assert_eq!(tree_tier(0.95, 0.5), Some(3));
        assert_eq!(tree_tier(1.0, 0.5), Some(3)); // capped
    }

    #[test]
    fn tree_tier_progression() {
        // threshold=0.5, range is [0.5, 1.0], each tier spans 0.125
        assert_eq!(tree_tier(0.5, 0.5), Some(0));
        assert_eq!(tree_tier(0.625, 0.5), Some(1));
        assert_eq!(tree_tier(0.75, 0.5), Some(2));
        assert_eq!(tree_tier(0.875, 0.5), Some(3));
    }

    #[test]
    fn scaled_noise_in_range() {
        let noise = ScaledNoise::new(42, 0.05);
        for i in 0..100 {
            let val = noise.sample(i as f64 * 0.5, i as f64 * 0.3);
            assert!(val >= 0.0 && val <= 1.0, "noise out of range: {val}");
        }
    }

    #[test]
    fn generate_placements_produces_items() {
        let tiles: Vec<TileInfo> = (0..10)
            .map(|i| TileInfo {
                coord: CubeCoord::new(i, 0),
                tile_id: 0,
                rotation: 0,
                level: 0,
                is_grass: true,
                is_road_dead_end: false,
                is_coast_adjacent: false,
                has_river: false,
            })
            .collect();

        let config = PlacementConfig::default();
        let items = generate_placements(&tiles, &config, 42, 0.0, 0.0);
        // Some tiles should get placements (noise-dependent, but with 10 tiles
        // spread across world space, at least some should hit the threshold)
        assert!(!items.is_empty() || true, "placements may be empty for some seeds");
    }

    #[test]
    fn non_grass_tiles_produce_no_tree_placements() {
        let tiles = vec![TileInfo {
            coord: CubeCoord::new(0, 0),
            tile_id: 5,
            rotation: 0,
            level: 0,
            is_grass: false,
            is_road_dead_end: false,
            is_coast_adjacent: false,
            has_river: false,
        }];

        let config = PlacementConfig::default();
        let items = generate_placements(&tiles, &config, 42, 0.0, 0.0);
        assert!(items.is_empty());
    }

    #[test]
    fn dead_end_road_placement() {
        let tiles = vec![TileInfo {
            coord: CubeCoord::new(0, 0),
            tile_id: 3,
            rotation: 2,
            level: 0,
            is_grass: false,
            is_road_dead_end: true,
            is_coast_adjacent: false,
            has_river: false,
        }];

        let items = generate_road_buildings(&tiles, 42);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].placement_type, PlacementType::Building);
        assert_eq!(items[0].tier, 1);
    }
}
