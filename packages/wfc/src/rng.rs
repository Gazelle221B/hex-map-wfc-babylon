/// Seeded deterministic PRNG using fastrand.
#[derive(Clone, Debug)]
pub struct Rng {
    inner: fastrand::Rng,
}

impl Rng {
    /// Create a new RNG with the given seed.
    pub fn new(seed: u64) -> Self {
        Self {
            inner: fastrand::Rng::with_seed(seed),
        }
    }

    /// Random f64 in [0.0, 1.0).
    pub fn f64(&mut self) -> f64 {
        self.inner.f64()
    }

    /// Random usize in [0, max).
    pub fn usize(&mut self, max: usize) -> usize {
        self.inner.usize(..max)
    }

    /// Weighted random selection. Returns the index of the selected item.
    /// Weights must be non-negative. Panics if weights is empty or all zero.
    pub fn weighted_choice(&mut self, weights: &[f64]) -> usize {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_with_same_seed() {
        let mut a = Rng::new(42);
        let mut b = Rng::new(42);
        let vals_a: Vec<f64> = (0..100).map(|_| a.f64()).collect();
        let vals_b: Vec<f64> = (0..100).map(|_| b.f64()).collect();
        assert_eq!(vals_a, vals_b);
    }

    #[test]
    fn different_seeds_differ() {
        let mut a = Rng::new(1);
        let mut b = Rng::new(2);
        let vals_a: Vec<f64> = (0..10).map(|_| a.f64()).collect();
        let vals_b: Vec<f64> = (0..10).map(|_| b.f64()).collect();
        assert_ne!(vals_a, vals_b);
    }

    #[test]
    fn weighted_choice_respects_weights() {
        let mut rng = Rng::new(42);
        let weights = [100.0, 0.0, 0.0];
        for _ in 0..100 {
            assert_eq!(rng.weighted_choice(&weights), 0);
        }
    }

    #[test]
    fn weighted_choice_distribution() {
        let mut rng = Rng::new(42);
        let weights = [1.0, 1.0, 1.0];
        let mut counts = [0u32; 3];
        for _ in 0..3000 {
            counts[rng.weighted_choice(&weights)] += 1;
        }
        // Each should get roughly 1000 ± 200
        for c in &counts {
            assert!(*c > 700 && *c < 1300, "uneven distribution: {counts:?}");
        }
    }
}
