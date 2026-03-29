import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { defaultOutputPath } from "./export-legacy-wfc-fixtures.mjs";
import { bucketSinglePassResult } from "./single-pass-grid-buckets.mjs";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.mode ?? null;
  const fixturePath = path.resolve(args.fixture ?? defaultOutputPath(mode ?? "progressive"));
  const seeds = parseSeeds(args.seeds ?? args.seed ?? null);

  const envelope = JSON.parse(await fs.readFile(fixturePath, "utf8"));
  const fixtures = Array.isArray(envelope.fixtures) ? envelope.fixtures : [];
  const targetFixtures = fixtures.filter((fixture) =>
    (!mode || fixture.mode === mode)
    && (!seeds || seeds.has(fixture.seed)));
  if (targetFixtures.length === 0) {
    const modeLabel = mode ? ` for mode ${mode}` : "";
    const seedLabel = seeds ? ` and seeds ${[...seeds].join(",")}` : "";
    throw new Error(`no fixtures found in ${fixturePath}${modeLabel}${seedLabel}`);
  }

  const { engine, free } = await loadEngine();
  try {
    const failures = [];
    for (const fixture of targetFixtures) {
      const diff = await compareFixture(engine, fixture);
      if (diff) {
        failures.push(diff);
      }
    }

    if (failures.length > 0) {
      for (const failure of failures) {
        console.error(`[${failure.mode}] seed ${failure.seed}: ${failure.message}`);
      }
      process.exitCode = 1;
      return;
    }

    console.log(`verified ${targetFixtures.length} fixture(s) from ${fixturePath}`);
  } finally {
    free();
  }
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      args[key] = "true";
      continue;
    }
    args[key] = value;
    index += 1;
  }
  return args;
}

function parseSeeds(value) {
  if (!value) {
    return null;
  }
  return new Set(value
    .split(",")
    .map((seed) => seed.trim())
    .filter(Boolean)
    .map((seed) => {
      const parsed = Number(seed);
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`invalid seed: ${seed}`);
      }
      return parsed;
    }));
}

async function loadEngine() {
  const wasmModule = await import(pathToModuleUrl("packages/wfc/wasm/wfc_core.js"));
  const wasmBytes = await fs.readFile(path.resolve("packages/wfc/wasm/wfc_core_bg.wasm"));
  await wasmModule.default({ module_or_path: wasmBytes });
  const engine = new wasmModule.WfcEngine();
  return {
    engine,
    free() {
      engine.free();
    },
  };
}

async function compareFixture(engine, fixture) {
  engine.reset();
  const actual = fixture.mode === "single-pass"
    ? normalizeSinglePassFixture(engine.solve_all_single_pass({
        seed: BigInt(fixture.seed),
        tile_types: null,
        wfc_mode: "legacy-compat",
      }), fixture)
    : normalizeProgressiveFixture(engine, fixture);

  const expected = JSON.stringify(normalizeExpectedFixture(fixture));
  const received = JSON.stringify(actual);
  if (expected === received) {
    return null;
  }

  const firstMismatch = firstMismatchPath(JSON.parse(expected), JSON.parse(received));
  return {
    mode: fixture.mode,
    seed: fixture.seed,
    message: firstMismatch ?? "fixture mismatch",
  };
}

function normalizeProgressiveFixture(engine, fixture) {
  const grids = fixture.grids.map((grid) => {
    const result = engine.solve_grid({
      seed: BigInt(fixture.seed),
      grid_q: grid.gridQ,
      grid_r: grid.gridR,
      tile_types: null,
      wfc_mode: "legacy-compat",
    });
    return normalizeGridResult({
      gridQ: grid.gridQ,
      gridR: grid.gridR,
      gridS: grid.gridS,
      gridX: grid.gridX,
      gridZ: grid.gridZ,
      ...result,
    });
  });

  return {
    seed: fixture.seed,
    mode: fixture.mode,
    status: grids.every((grid) => grid.status === "solved") ? "solved" : "failed",
    grids,
  };
}

function normalizeSinglePassFixture(result, fixture) {
  const buckets = bucketSinglePassResult(result, fixture.grids);

  const grids = buckets.map((grid) =>
    normalizeGridResult({
      ...grid,
      status: result.status,
      tiles: grid.tiles,
      collapse_order: grid.collapseOrder,
      changed_fixed_cells: [],
      unfixed_cells: [],
      dropped_cells: [],
      last_conflict: result.last_conflict,
      neighbor_conflict: result.neighbor_conflict,
      tries: result.tries ?? 0,
      backtracks: result.backtracks ?? 0,
      local_wfc_attempts: result.local_wfc_attempts ?? 0,
      dropped_count: result.dropped_count ?? 0,
    }));

  return {
    seed: fixture.seed,
    mode: "single-pass",
    status: result.status,
    grids,
  };
}

function normalizeExpectedFixture(fixture) {
  return {
    seed: fixture.seed,
    mode: fixture.mode,
    status: fixture.status ?? (fixture.grids.every((grid) => grid.status === "solved") ? "solved" : "failed"),
    grids: fixture.grids.map(normalizeGridResult),
  };
}

function normalizeGridResult(grid) {
  return {
    gridQ: grid.gridQ,
    gridR: grid.gridR,
    gridS: grid.gridS ?? (-grid.gridQ - grid.gridR),
    gridX: grid.gridX,
    gridZ: grid.gridZ,
    status: grid.status,
    tiles: normalizeTiles(grid.tiles ?? [], true),
    collapseOrder: normalizeTiles(grid.collapseOrder ?? grid.collapse_order ?? []),
    changedFixedCells: normalizeTiles(grid.changedFixedCells ?? grid.changed_fixed_cells ?? [], true),
    unfixedCells: normalizeCoords(grid.unfixedCells ?? grid.unfixed_cells ?? [], true),
    droppedCells: normalizeCoords(grid.droppedCells ?? grid.dropped_cells ?? [], true),
    lastConflict: normalizeConflict(grid.lastConflict ?? grid.last_conflict ?? null),
    neighborConflict: normalizeConflict(grid.neighborConflict ?? grid.neighbor_conflict ?? null),
    stats: {
      tries: grid.stats?.tries ?? grid.tries ?? 0,
      backtracks: grid.stats?.backtracks ?? grid.backtracks ?? 0,
      localWfcAttempts: grid.stats?.localWfcAttempts ?? grid.local_wfc_attempts ?? 0,
      droppedCount: grid.stats?.droppedCount ?? grid.dropped_count ?? 0,
    },
  };
}

function normalizeTiles(tiles, sort = false) {
  const normalized = tiles.map(normalizeTile);
  return sort ? normalized.sort(compareTileLike) : normalized;
}

function normalizeTile(tile) {
  return {
    q: tile.q,
    r: tile.r,
    s: tile.s ?? (-tile.q - tile.r),
    type: tile.type ?? tile.tile_id ?? tile.tileId,
    rotation: tile.rotation,
    level: tile.level ?? tile.elevation,
  };
}

function normalizeCoords(coords, sort = false) {
  const normalized = coords.map((coord) => ({
    q: coord.q,
    r: coord.r,
    s: coord.s ?? (-coord.q - coord.r),
  }));
  return sort ? normalized.sort(compareCoordLike) : normalized;
}

function normalizeConflict(conflict) {
  if (!conflict) {
    return null;
  }
  const failedCoord = conflict.failedKey ? parseCubeKey(conflict.failedKey) : null;
  const sourceCoord = conflict.sourceKey ? parseCubeKey(conflict.sourceKey) : null;
  const sourceQ = conflict.sourceQ ?? conflict.source_q ?? sourceCoord?.q ?? null;
  const sourceR = conflict.sourceR ?? conflict.source_r ?? sourceCoord?.r ?? null;
  const sourceS = conflict.sourceS ?? conflict.source_s ?? sourceCoord?.s ?? null;
  return {
    failedQ: conflict.failedQ ?? conflict.failed_q ?? failedCoord?.q ?? null,
    failedR: conflict.failedR ?? conflict.failed_r ?? failedCoord?.r ?? null,
    failedS: conflict.failedS ?? conflict.failed_s ?? failedCoord?.s ?? null,
    sourceQ,
    sourceR,
    sourceS,
    sourceKey: conflict.sourceKey ?? (sourceQ === null ? null : cubeKey(sourceQ, sourceR, sourceS)),
    dir: conflict.dir ?? null,
  };
}

function parseCubeKey(key) {
  if (!key) {
    return null;
  }
  const [q, r] = key.split(",").map((part) => Number(part));
  if (!Number.isInteger(q) || !Number.isInteger(r)) {
    return null;
  }
  return {
    q,
    r,
    s: -q - r,
  };
}

function cubeKey(q, r, s = -q - r) {
  return `${q},${r},${s}`;
}

function compareCoordLike(left, right) {
  return left.q - right.q || left.r - right.r || left.s - right.s;
}

function compareTileLike(left, right) {
  return compareCoordLike(left, right)
    || left.type - right.type
    || left.rotation - right.rotation
    || left.level - right.level;
}

function firstMismatchPath(left, right, path = "$") {
  if (typeof left !== typeof right) {
    return `${path}: type mismatch (${typeof left} !== ${typeof right})`;
  }
  if (left === null || right === null) {
    return left === right ? null : `${path}: ${JSON.stringify(left)} !== ${JSON.stringify(right)}`;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) {
      return `${path}: array mismatch`;
    }
    if (left.length !== right.length) {
      return `${path}.length: ${left.length} !== ${right.length}`;
    }
    for (let index = 0; index < left.length; index += 1) {
      const mismatch = firstMismatchPath(left[index], right[index], `${path}[${index}]`);
      if (mismatch) {
        return mismatch;
      }
    }
    return null;
  }
  if (typeof left === "object") {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of [...keys].sort()) {
      if (!(key in left) || !(key in right)) {
        return `${path}.${key}: missing key`;
      }
      const mismatch = firstMismatchPath(left[key], right[key], `${path}.${key}`);
      if (mismatch) {
        return mismatch;
      }
    }
    return null;
  }
  return left === right ? null : `${path}: ${JSON.stringify(left)} !== ${JSON.stringify(right)}`;
}

function pathToModuleUrl(relativePath) {
  return pathToFileURL(path.resolve(relativePath)).href;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
