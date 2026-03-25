/// Cube coordinate for hexagonal grids.
/// Invariant: q + r + s == 0
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct CubeCoord {
    pub q: i32,
    pub r: i32,
    pub s: i32,
}

impl CubeCoord {
    pub fn new(q: i32, r: i32) -> Self {
        Self { q, r, s: -q - r }
    }

    /// String key for HashMap lookups: "q,r,s"
    pub fn key(&self) -> String {
        format!("{},{},{}", self.q, self.r, self.s)
    }

    /// Manhattan distance between two cube coords.
    pub fn distance(&self, other: &CubeCoord) -> i32 {
        ((self.q - other.q).abs() + (self.r - other.r).abs() + (self.s - other.s).abs()) / 2
    }

    /// Get neighbor in the given direction.
    pub fn neighbor(&self, dir: HexDir) -> CubeCoord {
        let (dq, dr, ds) = dir.offset();
        CubeCoord {
            q: self.q + dq,
            r: self.r + dr,
            s: self.s + ds,
        }
    }

    /// Get all 6 neighbors.
    pub fn neighbors(&self) -> [CubeCoord; 6] {
        HexDir::ALL.map(|d| self.neighbor(d))
    }

    /// All cells within radius (inclusive) of this coord.
    pub fn cells_in_radius(&self, radius: i32) -> Vec<CubeCoord> {
        let mut cells = Vec::new();
        for q in -radius..=radius {
            for r in (-radius).max(-q - radius)..=radius.min(-q + radius) {
                cells.push(CubeCoord {
                    q: self.q + q,
                    r: self.r + r,
                    s: self.s - q - r,
                });
            }
        }
        cells
    }

    /// Convert cube coord to world position (pointy-top hex).
    /// Returns (x, z) in world space. Y is determined by elevation.
    pub fn to_world(&self, hex_width: f64) -> (f64, f64) {
        let size = hex_width / 2.0;
        let x = size * (3.0_f64.sqrt() * self.q as f64 + 3.0_f64.sqrt() / 2.0 * self.r as f64);
        let z = size * (3.0 / 2.0 * self.r as f64);
        (x, z)
    }
}

/// The 6 hex directions (pointy-top orientation).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum HexDir {
    NE = 0,
    E = 1,
    SE = 2,
    SW = 3,
    W = 4,
    NW = 5,
}

impl HexDir {
    pub const ALL: [HexDir; 6] = [
        HexDir::NE,
        HexDir::E,
        HexDir::SE,
        HexDir::SW,
        HexDir::W,
        HexDir::NW,
    ];

    /// Cube coordinate offset for this direction.
    pub fn offset(&self) -> (i32, i32, i32) {
        match self {
            HexDir::NE => (1, -1, 0),
            HexDir::E => (1, 0, -1),
            HexDir::SE => (0, 1, -1),
            HexDir::SW => (-1, 1, 0),
            HexDir::W => (-1, 0, 1),
            HexDir::NW => (0, -1, 1),
        }
    }

    /// Opposite direction.
    pub fn opposite(&self) -> HexDir {
        match self {
            HexDir::NE => HexDir::SW,
            HexDir::E => HexDir::W,
            HexDir::SE => HexDir::NW,
            HexDir::SW => HexDir::NE,
            HexDir::W => HexDir::E,
            HexDir::NW => HexDir::SE,
        }
    }

    /// Rotate direction by N steps (each step = 60° clockwise).
    pub fn rotate(&self, steps: u8) -> HexDir {
        let idx = (*self as u8 + steps) % 6;
        HexDir::ALL[idx as usize]
    }

    /// Index (0-5) for array lookups.
    pub fn index(&self) -> usize {
        *self as usize
    }

    /// From index (0-5).
    pub fn from_index(i: usize) -> HexDir {
        HexDir::ALL[i % 6]
    }
}

/// Rotate hex edges by N steps (each step = 60° clockwise).
/// Input: edges[0..6] indexed by HexDir order (NE=0, E=1, ..., NW=5).
/// Returns new edges with directions shifted.
pub fn rotate_edges<T: Copy>(edges: &[T; 6], rotation: u8) -> [T; 6] {
    let r = (rotation % 6) as usize;
    let mut rotated = *edges;
    for i in 0..6 {
        rotated[(i + r) % 6] = edges[i];
    }
    rotated
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cube_coord_invariant() {
        let c = CubeCoord::new(3, -5);
        assert_eq!(c.q + c.r + c.s, 0);
    }

    #[test]
    fn neighbor_and_back() {
        let origin = CubeCoord::new(0, 0);
        for dir in HexDir::ALL {
            let n = origin.neighbor(dir);
            let back = n.neighbor(dir.opposite());
            assert_eq!(back, origin, "dir={dir:?}");
        }
    }

    #[test]
    fn distance_to_self_is_zero() {
        let c = CubeCoord::new(3, -2);
        assert_eq!(c.distance(&c), 0);
    }

    #[test]
    fn distance_to_neighbor_is_one() {
        let origin = CubeCoord::new(0, 0);
        for dir in HexDir::ALL {
            assert_eq!(origin.distance(&origin.neighbor(dir)), 1);
        }
    }

    #[test]
    fn cells_in_radius_count() {
        let origin = CubeCoord::new(0, 0);
        // Hex grid cell count for radius r = 3r² + 3r + 1
        assert_eq!(origin.cells_in_radius(0).len(), 1);
        assert_eq!(origin.cells_in_radius(1).len(), 7);
        assert_eq!(origin.cells_in_radius(2).len(), 19);
        assert_eq!(origin.cells_in_radius(8).len(), 217);
    }

    #[test]
    fn rotation_wraps() {
        assert_eq!(HexDir::NE.rotate(6), HexDir::NE);
        assert_eq!(HexDir::NE.rotate(1), HexDir::E);
        assert_eq!(HexDir::NW.rotate(1), HexDir::NE);
    }

    #[test]
    fn rotate_edges_identity() {
        let edges = [0, 1, 2, 3, 4, 5];
        assert_eq!(rotate_edges(&edges, 0), edges);
    }

    #[test]
    fn rotate_edges_one_step() {
        let edges = [10, 20, 30, 40, 50, 60];
        let rotated = rotate_edges(&edges, 1);
        // NE(0) edge value moves to E(1) position
        assert_eq!(rotated[1], 10);
        assert_eq!(rotated[2], 20);
        assert_eq!(rotated[0], 60);
    }

    #[test]
    fn world_position_origin() {
        let origin = CubeCoord::new(0, 0);
        let (x, z) = origin.to_world(2.0);
        assert!((x).abs() < 1e-10);
        assert!((z).abs() < 1e-10);
    }
}
