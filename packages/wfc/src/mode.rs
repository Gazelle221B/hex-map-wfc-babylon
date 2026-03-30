use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum WfcMode {
    #[default]
    LegacyCompat,
    ModernFast,
}

impl WfcMode {
    pub fn as_str(self) -> &'static str {
        match self {
            WfcMode::LegacyCompat => "legacy-compat",
            WfcMode::ModernFast => "modern-fast",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BuildMode {
    #[default]
    Progressive,
    SinglePass,
}

impl BuildMode {
    pub fn as_str(self) -> &'static str {
        match self {
            BuildMode::Progressive => "progressive",
            BuildMode::SinglePass => "single-pass",
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct SolveBehavior {
    pub eager_collapse: bool,
    pub grass_any_level: bool,
    pub use_input_order: bool,
    pub backtrack_limit_is_inclusive: bool,
    pub strict_prune_conflicts: bool,
}

impl SolveBehavior {
    pub fn for_mode(mode: WfcMode) -> Self {
        match mode {
            WfcMode::LegacyCompat => Self {
                eager_collapse: false,
                grass_any_level: false,
                use_input_order: true,
                backtrack_limit_is_inclusive: true,
                strict_prune_conflicts: false,
            },
            WfcMode::ModernFast => Self {
                eager_collapse: true,
                grass_any_level: true,
                use_input_order: false,
                backtrack_limit_is_inclusive: false,
                strict_prune_conflicts: true,
            },
        }
    }
}
