use crate::hex::CubeCoord;

const HEX_WIDTH: f64 = 2.0;
const HEX_HEIGHT: f64 = 2.309_401_076_758_503;
const GRID_DIR_N: u8 = 0;
const GRID_DIR_NE: u8 = 1;
const GRID_DIR_SE: u8 = 2;
const GRID_DIR_S: u8 = 3;
const GRID_DIR_SW: u8 = 4;
const GRID_DIR_NW: u8 = 5;

pub fn logical_grid_to_offset(grid_pos: CubeCoord) -> (i32, i32) {
    let grid_x = grid_pos.q;
    let grid_z = grid_pos.r + ((grid_pos.q - (grid_pos.q & 1)) / 2);
    (grid_x, grid_z)
}

pub fn grid_center(grid_pos: CubeCoord, tile_radius: i32) -> CubeCoord {
    let (grid_x, grid_z) = logical_grid_to_offset(grid_pos);
    let (world_x, world_z) = calculate_world_offset(grid_x, grid_z, tile_radius);
    let (col, row) = world_to_offset(world_x, world_z);
    offset_to_cube(col, row)
}

fn calculate_world_offset(grid_x: i32, grid_z: i32, tile_radius: i32) -> (f64, f64) {
    if grid_x == 0 && grid_z == 0 {
        return (0.0, 0.0);
    }

    let mut total_x = 0.0;
    let mut total_z = 0.0;
    let mut current_x = 0;
    let mut current_z = 0;

    while current_x != grid_x || current_z != grid_z {
        let dx = grid_x - current_x;
        let dz = grid_z - current_z;
        let is_odd_col = current_x.abs() % 2 == 1;

        let (direction, next_x, next_z) = if dx == 0 {
            if dz < 0 {
                (GRID_DIR_N, current_x, current_z - 1)
            } else {
                (GRID_DIR_S, current_x, current_z + 1)
            }
        } else if dx > 0 {
            if dz < 0 || (dz == 0 && !is_odd_col) {
                (
                    GRID_DIR_NE,
                    current_x + 1,
                    current_z + if is_odd_col { 0 } else { -1 },
                )
            } else {
                (
                    GRID_DIR_SE,
                    current_x + 1,
                    current_z + if is_odd_col { 1 } else { 0 },
                )
            }
        } else if dz < 0 || (dz == 0 && !is_odd_col) {
            (
                GRID_DIR_NW,
                current_x - 1,
                current_z + if is_odd_col { 0 } else { -1 },
            )
        } else {
            (
                GRID_DIR_SW,
                current_x - 1,
                current_z + if is_odd_col { 1 } else { 0 },
            )
        };

        let (offset_x, offset_z) = get_grid_world_offset(tile_radius, direction);
        total_x += offset_x;
        total_z += offset_z;
        current_x = next_x;
        current_z = next_z;
    }

    (total_x, total_z)
}

fn get_grid_world_offset(tile_radius: i32, direction: u8) -> (f64, f64) {
    let diameter = (tile_radius * 2 + 1) as f64;
    let grid_width = diameter * HEX_WIDTH;
    let grid_height = diameter * HEX_HEIGHT * 0.75;
    let half = HEX_WIDTH * 0.5;

    match direction {
        GRID_DIR_N => (half, -grid_height),
        GRID_DIR_NE => (grid_width * 0.75 + half * 0.5, -grid_height * 0.5 + half * 0.866),
        GRID_DIR_SE => (grid_width * 0.75 - half * 0.5, grid_height * 0.5 + half * 0.866),
        GRID_DIR_S => (-half, grid_height),
        GRID_DIR_SW => (-grid_width * 0.75 - half * 0.5, grid_height * 0.5 - half * 0.866),
        GRID_DIR_NW => (-grid_width * 0.75 + half * 0.5, -grid_height * 0.5 - half * 0.866),
        _ => unreachable!("invalid grid direction"),
    }
}

fn world_to_offset(world_x: f64, world_z: f64) -> (i32, i32) {
    let row = js_math_round(world_z / (HEX_HEIGHT * 0.75));
    let stagger = ((row.abs() % 2) as f64) * HEX_WIDTH * 0.5;
    let col = js_math_round((world_x - stagger) / HEX_WIDTH);
    (col, row)
}

fn offset_to_cube(col: i32, row: i32) -> CubeCoord {
    let q = col - row.div_euclid(2);
    CubeCoord::new(q, row)
}

fn js_math_round(value: f64) -> i32 {
    (value + 0.5).floor() as i32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logical_grid_offset_matches_legacy_odd_q_layout() {
        assert_eq!(logical_grid_to_offset(CubeCoord::new(0, 0)), (0, 0));
        assert_eq!(logical_grid_to_offset(CubeCoord::new(-1, 0)), (-1, -1));
        assert_eq!(logical_grid_to_offset(CubeCoord::new(-1, 1)), (-1, 0));
        assert_eq!(logical_grid_to_offset(CubeCoord::new(1, 0)), (1, 0));
    }

    #[test]
    fn grid_center_matches_legacy_fixture_positions() {
        assert_eq!(grid_center(CubeCoord::new(0, 0), 8), CubeCoord::new(0, 0));
        assert_eq!(grid_center(CubeCoord::new(-1, 0), 8), CubeCoord::new(-8, -9));
        assert_eq!(grid_center(CubeCoord::new(-1, 1), 8), CubeCoord::new(-17, 8));
        assert_eq!(grid_center(CubeCoord::new(0, -1), 8), CubeCoord::new(9, -17));
        assert_eq!(grid_center(CubeCoord::new(0, 1), 8), CubeCoord::new(-9, 17));
        assert_eq!(grid_center(CubeCoord::new(1, 0), 8), CubeCoord::new(8, 9));
    }
}
