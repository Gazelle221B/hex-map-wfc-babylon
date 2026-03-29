pub trait RandomSource {
    fn f64(&mut self) -> f64;

    fn weighted_choice(&mut self, weights: &[f64]) -> usize {
        let total: f64 = weights.iter().sum();
        assert!(total > 0.0, "weights must have positive total");
        let mut r = self.f64() * total;
        for (i, &w) in weights.iter().enumerate() {
            r -= w;
            if r <= 0.0 {
                return i;
            }
        }
        weights.len() - 1
    }
}

/// Seeded deterministic PRNG using fastrand.
#[derive(Clone, Debug)]
pub struct Rng {
    inner: fastrand::Rng,
}

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self {
            inner: fastrand::Rng::with_seed(seed),
        }
    }

    pub fn usize(&mut self, max: usize) -> usize {
        self.inner.usize(..max)
    }
}

impl RandomSource for Rng {
    fn f64(&mut self) -> f64 {
        self.inner.f64()
    }
}

/// Mulberry32 compatible with the original JavaScript implementation.
#[derive(Clone, Debug)]
pub struct Mulberry32 {
    state: u32,
}

impl Mulberry32 {
    pub fn new(seed: u64) -> Self {
        Self {
            state: seed as u32,
        }
    }

    pub fn reseed(&mut self, seed: u64) {
        self.state = seed as u32;
    }
}

impl RandomSource for Mulberry32 {
    fn f64(&mut self) -> f64 {
        self.state = self.state.wrapping_add(0x6D2B_79F5);
        let mut t = i32::wrapping_mul(
            (self.state ^ (self.state >> 15)) as i32,
            (1 | self.state) as i32,
        ) as u32;
        t = (t as i32)
            .wrapping_add(i32::wrapping_mul(
                (t ^ (t >> 7)) as i32,
                (61 | t) as i32,
            )) as u32
            ^ t;
        ((t ^ (t >> 14)) as f64) / 4_294_967_296.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collect_n<R: RandomSource>(rng: &mut R, count: usize) -> Vec<f64> {
        (0..count).map(|_| rng.f64()).collect()
    }

    #[test]
    fn fast_rng_is_deterministic_with_same_seed() {
        let mut a = Rng::new(42);
        let mut b = Rng::new(42);
        assert_eq!(collect_n(&mut a, 32), collect_n(&mut b, 32));
    }

    #[test]
    fn mulberry32_matches_known_js_values() {
        let mut rng = Mulberry32::new(42);
        let actual = collect_n(&mut rng, 5);
        let expected = vec![
            0.6011037519201636,
            0.44829055899754167,
            0.8524657934904099,
            0.6697340414393693,
            0.17481389874592423,
        ];
        for (left, right) in actual.iter().zip(expected.iter()) {
            assert!(
                (left - right).abs() < 1e-12,
                "expected {right}, got {left}"
            );
        }
    }

    #[test]
    fn mulberry32_stream_is_isolated_per_instance() {
        let mut layout_rng = Mulberry32::new(42);
        let mut solver_rng = Mulberry32::new(42);
        let mut control_rng = Mulberry32::new(42);

        let solver_head = collect_n(&mut solver_rng, 3);
        let _layout_noise = collect_n(&mut layout_rng, 5);
        let solver_tail = collect_n(&mut solver_rng, 3);
        let expected = collect_n(&mut control_rng, 6);

        assert_eq!(solver_head, expected[..3]);
        assert_eq!(solver_tail, expected[3..]);
    }

    #[test]
    fn weighted_choice_respects_weights() {
        let mut rng = Rng::new(42);
        let weights = [100.0, 0.0, 0.0];
        for _ in 0..100 {
            assert_eq!(rng.weighted_choice(&weights), 0);
        }
    }
}
