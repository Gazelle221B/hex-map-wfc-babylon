/**
 * Full map configuration. Controls WFC, rendering, and post-processing.
 * All fields are required; use DEFAULT_CONFIG as a starting point.
 */
export interface MapConfig {
  // --- WFC ---
  readonly seed: number;
  readonly gridRadius: number;
  readonly maxBacktracks: number;
  readonly maxTries: number;

  // --- AO ---
  readonly aoEnabled: boolean;
  readonly aoRadius: number;
  readonly aoSamples: number;
  readonly aoTotalStrength: number;

  // --- DoF ---
  readonly dofEnabled: boolean;
  readonly dofFocalLength: number;
  readonly dofFStop: number;

  // --- Vignette ---
  readonly vignetteEnabled: boolean;
  readonly vignetteWeight: number;

  // --- Grain ---
  readonly grainEnabled: boolean;
  readonly grainIntensity: number;

  // --- Water ---
  readonly waterOpacity: number;
  readonly waterSpeed: number;
  readonly waterFreq: number;
  readonly waterBrightness: number;
  readonly waterContrast: number;
  readonly waveSpeed: number;
  readonly waveCount: number;
  readonly waveOpacity: number;
  readonly waveNoiseBreak: number;
  readonly waveWidth: number;

  // --- Shadow ---
  readonly shadowEnabled: boolean;
  readonly shadowResolution: number;

  // --- Camera ---
  readonly cameraFov: number;
  readonly cameraMinDistance: number;
  readonly cameraMaxDistance: number;
  readonly cameraMaxPolarAngle: number;
}

export const DEFAULT_CONFIG: MapConfig = {
  seed: 42,
  gridRadius: 8,
  maxBacktracks: 500,
  maxTries: 2,

  aoEnabled: true,
  aoRadius: 2.0,
  aoSamples: 16,
  aoTotalStrength: 1.0,

  dofEnabled: true,
  dofFocalLength: 150,
  dofFStop: 1.4,

  vignetteEnabled: true,
  vignetteWeight: 1.5,

  grainEnabled: true,
  grainIntensity: 15,

  waterOpacity: 0.1,
  waterSpeed: 0.3,
  waterFreq: 0.9,
  waterBrightness: 0.29,
  waterContrast: 17.5,
  waveSpeed: 2,
  waveCount: 4,
  waveOpacity: 0.5,
  waveNoiseBreak: 0.135,
  waveWidth: 0.61,

  shadowEnabled: true,
  shadowResolution: 4096,

  cameraFov: 20,
  cameraMinDistance: 25,
  cameraMaxDistance: 410,
  cameraMaxPolarAngle: 1.414, // ~81°
} as const;
