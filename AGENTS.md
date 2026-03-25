# AGENTS.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Project Overview

Hex map procedural generation using Wave Function Collapse (WFC) with Babylon.js rendering. The WFC algorithm is implemented in Rust and compiled to WebAssembly for performance, running in a web worker to avoid blocking the UI.

## Commands

### Development
```bash
# Start dev server (builds WASM first)
pnpm run dev

# Build WASM only
pnpm run build:wasm

# Production build
pnpm run build
```

### Testing
```bash
# Run Rust WFC tests
pnpm run test:rust
# Or directly:
cargo test -p wfc-core

# Run a single test
cargo test -p wfc-core test_name
```

### Prerequisites Setup
```bash
# Install tool versions (via mise)
mise install

# Add WASM target
rustup target add wasm32-unknown-unknown

# Install WASM tools
cargo install wasm-bindgen-cli@0.2.100
cargo install wasm-opt --version 0.116.1
```

## Architecture

### Monorepo Structure
- `packages/wfc/` - Rust WFC core compiled to WASM
- `packages/types/` - Shared TypeScript types (`@hex/types`)
- `packages/render/` - Babylon.js rendering (`@hex/render`)
- `packages/app/` - Main application entry (`@hex/app`)

### WFC Core (Rust)
The solver in `packages/wfc/src/solver.rs` uses trail-based backtracking:
1. Find cell with lowest entropy (fewest possibilities)
2. Collapse to a weighted random state
3. Propagate constraints to neighbors
4. Backtrack on contradiction

Key files:
- `solver.rs` - Main WFC algorithm
- `api.rs` - WASM bindings (`WfcEngine` class exposed to JS)
- `multi_grid.rs` - Global map across multiple grid solves
- `placement.rs` - Building/object placement generation

### TypeScript Layer
- `WfcBridge` (in `@hex/wfc`) spawns a web worker that loads the WASM module
- The renderer uses a tile pooling system for efficient hex mesh reuse
- Hex coordinates use cube/axial system (q, r, s where s = -q - r)

### Data Flow
1. App boot creates renderer and WfcBridge
2. WfcBridge worker initializes WASM WfcEngine
3. `solve_all()` solves 19 grids (center first, then outward in rings)
4. Global map coordinates are shared across grids for edge consistency
5. Placements generated from solved tiles (buildings, trees, etc.)
6. Renderer displays results via Babylon.js

## Tile System

Tiles have 6 edges (hex directions) with types: Grass, Road, River, Coast, Cliff. Edge compatibility rules determine valid adjacencies. Tiles support multiple levels (heights) with edge-level matching for cliffs and rivers.

Tile definitions are duplicated in both Rust (`packages/wfc/src/tile.rs`) and TypeScript (`packages/types/src/tile-def.ts`). Changes to tile definitions must be applied to both files to maintain consistency.