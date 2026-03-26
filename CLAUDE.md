# Project Instructions

## Tech Stack

TypeScript 5.7 + Rust (stable) monorepo. Babylon.js 8.x (WebGPU) for rendering, Rust WFC solver compiled to WASM via wasm-bindgen. Vite 6 bundler, pnpm workspaces.

## Monorepo Packages

- `@hex/types` — shared types + constants (no runtime code)
- `@hex/wfc` — Rust WFC core (WASM) + TypeScript bridge/worker
- `@hex/render` — Babylon.js rendering engine + WGSL shaders
- `@hex/post` — post-processing (SSAO, DoF, vignette, grain) [not yet implemented]
- `@hex/ui` — lil-gui parameter panel [not yet implemented]
- `@hex/assets` — glTF tiles + textures + manifest [not yet implemented]
- `@hex/app` — composition root (sole assembly point)
- `@hex/tsconfig` — shared TypeScript config

## Commands

```bash
pnpm run dev          # Build WASM + start Vite dev server
pnpm run build        # Production build (WASM + Vite)
pnpm run build:wasm   # WASM only
pnpm run test:rust    # cargo test -p wfc-core
```

## Code Style

- Files: kebab-case (`grid-mesh.ts`)
- Functions: camelCase, factories use `create*`
- Types/Interfaces: PascalCase, all properties `readonly`
- Constants: UPPER_SNAKE_CASE + `as const`
- Immutable data everywhere — create new objects, never mutate

## TypeScript

- Strict mode enabled, no unused locals/params
- Module resolution: `bundler` (ESNext)
- All packages extend `@hex/tsconfig/base.json`

## Rust

- WASM target: `wasm32-unknown-unknown`
- Error handling: `Result<T, JsValue>` with `map_err()`
- Release profile: opt-level=z, LTO, strip

## Architecture Rules

- Types flow through `@hex/types` — single source of truth
- Only `@hex/app` assembles packages (composition root pattern)
- No horizontal dependencies between packages (render doesn't know wfc, etc.)
- Tile definitions exist in both TS and Rust — **must stay in sync**:
  - `packages/types/src/tile-def.ts`
  - `packages/wfc/src/tile.rs`
- Hex coordinates: cube/axial system (q, r, s where s = -q - r)
- 43 tile types, grid radius 8, 19 grids (center + 2 rings)
- WGSL shaders: use Babylon.js conventions (no @group/@binding, use vertexInputs/vertexOutputs)

## Testing

- Rust tests: `cargo test -p wfc-core`
- No TypeScript test framework configured yet

## Progress

Phase 1-3 complete (workspace, types, WFC basics, Babylon rendering foundation).
Next: Phase 4 (WGSL shaders), Phase 5 (post-processing), Phase 6 (UI + polish).
See `docs/TDD.md` for full design spec and implementation phases.

## Reference

- Original: [felixturner/hex-map-wfc](https://github.com/felixturner/hex-map-wfc) (Three.js, JS)
- Local clone: `/Users/kairyon/projects/hex-map-wfc`

## Commit Style

```
<type>: <description>
```

Types: feat, fix, refactor, docs, test, chore, perf, ci
