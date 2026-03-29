import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  DEFAULT_REPO_PATH,
  LegacyFixtureRunner,
  defaultOutputPath,
  loadLegacyModules,
} from "./export-legacy-wfc-fixtures.mjs";
import { bucketSinglePassResult } from "./single-pass-grid-buckets.mjs";

const DEFAULT_MODE = "progressive";
const DEFAULT_FIXTURE_PATH = path.resolve(defaultOutputPath(DEFAULT_MODE));
const DEFAULT_WATCH_COORDS = [
  { q: -22, r: 6, s: 16 },
  { q: -21, r: 5, s: 16 },
  { q: -23, r: 7, s: 16 },
  { q: -22, r: 7, s: 15 },
];
const DEFAULT_WATCH_AFTER_STEPS = [349, 350];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.mode ?? DEFAULT_MODE;
  const repoPath = path.resolve(args.repo ?? DEFAULT_REPO_PATH);
  const fixturePath = path.resolve(args.fixture ?? defaultOutputPath(mode));
  const seed = parseIntArg(args.seed ?? "42", "seed");
  const gridIndex = parseIntArg(args.gridIndex ?? "2", "gridIndex");
  const watchCoords = parseWatchCoords(args["watch-coords"] ?? args.watchCoords ?? null, mode);
  const watchAfterSteps = parseWatchSteps(args["watch-steps"] ?? args.watchSteps ?? null, mode);

  const fixture = await loadFixture(fixturePath, seed, mode);
  const modules = await loadLegacyModules(repoPath, "layout");
  const runner = new LegacyFixtureRunner(repoPath, modules);

  const { engine, free } = await loadEngine();
  try {
    modules.seed.setSeed(seed);
    await runner.ensureWorker(seed);
    if (mode === "single-pass") {
      await runSinglePassTrace({
        engine,
        fixture,
        modules,
        runner,
        seed,
        watchCoords,
        watchAfterSteps,
      });
      return;
    }

    await runProgressiveTrace({
      engine,
      fixture,
      modules,
      runner,
      seed,
      gridIndex,
      watchCoords,
      watchAfterSteps,
    });
  } finally {
    free();
    await runner.dispose();
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
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = "true";
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

function parseIntArg(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`invalid ${name}: ${value}`);
  }
  return parsed;
}

function parseWatchSteps(value, mode) {
  if (!value) {
    return mode === "single-pass" ? [] : DEFAULT_WATCH_AFTER_STEPS;
  }
  return value
    .split(",")
    .map((part) => parseIntArg(part.trim(), "watch step"));
}

function parseWatchCoords(value, mode) {
  if (!value) {
    return mode === "single-pass" ? [] : DEFAULT_WATCH_COORDS;
  }
  return value
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const parts = entry.split(",").map((part) => Number(part.trim()));
      if (parts.length < 2 || parts.length > 3 || parts.some((part) => !Number.isInteger(part))) {
        throw new Error(`invalid watch coord: ${entry}`);
      }
      const [q, r, s] = parts;
      return s === undefined ? { q, r } : { q, r, s };
    });
}

async function loadFixture(fixturePath, seed, mode) {
  const raw = JSON.parse(await fs.readFile(fixturePath, "utf8"));
  const fixture = (raw.fixtures ?? []).find((entry) => entry.mode === mode && entry.seed === seed);
  if (!fixture) {
    throw new Error(`${mode} fixture for seed ${seed} not found in ${fixturePath}`);
  }
  return fixture;
}

async function loadEngine() {
  const wasmModule = await import(pathToFileURL(path.resolve("packages/wfc/wasm/wfc_core.js")).href);
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

function buildGridDescriptors(runner) {
  return runner.sortedGridCoords().map((coord) => ({
    gridQ: coord.q,
    gridR: coord.r,
    gridS: coord.s,
    gridX: coord.gridX,
    gridZ: coord.gridZ,
    center: runner.gridCenter(coord.gridX, coord.gridZ),
  }));
}

async function runProgressiveTrace({
  engine,
  fixture,
  modules,
  runner,
  seed,
  gridIndex,
  watchCoords,
  watchAfterSteps,
}) {
  const grids = buildGridDescriptors(runner);
  const targetGrid = grids[gridIndex];
  if (!targetGrid) {
    throw new Error(`gridIndex ${gridIndex} is out of range`);
  }
  const targetFixtureGrid = normalizeGridForCompare(fixture.grids[gridIndex]);

  await primeProgressivePrefix(runner, engine, fixture, grids, seed, gridIndex);

  const jsContext = runner.buildContext(targetGrid);
  const jsAttempt = await traceWithWorker(runner, jsContext.solveCells, jsContext.fixedCells, {
    tileTypes: jsContext.tileTypes,
    maxTries: 2,
    initialCollapses: jsContext.initialCollapses,
    gridId: jsContext.gridKey,
    attemptNum: jsContext.attempt + 1,
    watchCoords,
    watchAfterSteps,
    neighborCells: jsContext.fixedCells.map((cell) => ({
      ...cell,
      anchors: (jsContext.anchorMap.get(modules.core.cubeKey(cell.q, cell.r, cell.s)) ?? []).map(cloneTile),
    })),
  });

  const rustAttempt = engine.debug_legacy_trace_grid_once({
    seed: BigInt(seed),
    grid_q: targetGrid.gridQ,
    grid_r: targetGrid.gridR,
    tile_types: null,
    wfc_mode: "legacy-compat",
    watch_coords: watchCoords,
    watch_after_steps: watchAfterSteps,
  });
  const rustProduction = normalizeGridForCompare(
    engine.solve_grid({
      seed: BigInt(seed),
      grid_q: targetGrid.gridQ,
      grid_r: targetGrid.gridR,
      tile_types: null,
      wfc_mode: "legacy-compat",
    }),
  );

  const jsNormalized = normalizeTraceEnvelope({
    success: jsAttempt.success,
    trace: jsAttempt.trace ?? [],
    tiles: jsAttempt.tiles ?? [],
    collapseOrder: jsAttempt.collapseOrder ?? [],
    fixedCells: jsContext.fixedCells,
    initialCollapses: jsContext.initialCollapses,
    backtracks: jsAttempt.backtracks ?? 0,
    tries: jsAttempt.tries ?? 0,
    watchedSnapshots: jsAttempt.watchedSnapshots ?? [],
    lastConflict: jsAttempt.lastConflict ?? null,
    neighborConflict: jsAttempt.neighborConflict ?? null,
  });
  const rustRaw = normalizeTraceEnvelope({
    success: rustAttempt.success,
    trace: rustAttempt.trace ?? [],
    tiles: rustAttempt.tiles ?? [],
    collapseOrder: rustAttempt.collapse_order ?? [],
    fixedCells: rustAttempt.fixed_cells ?? [],
    initialCollapses: rustAttempt.initial_collapses ?? [],
    backtracks: rustAttempt.backtracks ?? 0,
    watchedSnapshots: rustAttempt.watched_snapshots ?? [],
    lastConflict: rustAttempt.last_conflict ?? null,
    neighborConflict: rustAttempt.neighbor_conflict ?? null,
    tries: rustAttempt.tries ?? 0,
  });
  const rustNormalized = rustAttempt.normalized_result
    ? normalizeGridForCompare(rustAttempt.normalized_result)
    : null;

  reportTraceComparison({
    label: `seed ${seed} grid ${gridIndex} (${targetGrid.gridQ},${targetGrid.gridR})`,
    jsNormalized,
    rustRaw,
    normalizedTarget: targetFixtureGrid,
    rustNormalized,
    rustProduction,
  });
}

async function runSinglePassTrace({
  engine,
  fixture,
  modules,
  runner,
  seed,
  watchCoords,
  watchAfterSteps,
}) {
  const grids = buildGridDescriptors(runner);
  const allSolveCells = [];
  const solveKeys = new Set();
  for (const grid of grids) {
    for (const cell of runner.solveCellsForCenter(grid.center)) {
      const key = modules.core.cubeKey(cell.q, cell.r, cell.s);
      if (solveKeys.has(key)) {
        continue;
      }
      solveKeys.add(key);
      allSolveCells.push(cell);
    }
  }

  const centerGrid = grids.find((grid) => grid.gridQ === 0 && grid.gridR === 0);
  if (!centerGrid) {
    throw new Error("center grid not found");
  }
  const initialCollapses = [
    {
      q: centerGrid.center.q,
      r: centerGrid.center.r,
      s: centerGrid.center.s,
      type: modules.tile.TileType.GRASS,
      rotation: 0,
      level: 0,
    },
    ...runner.getMapCornerOceanSeeds(),
  ];
  const tileTypes = modules.tile.TILE_LIST.map((_, index) => index);

  const jsAttempt = await traceWithWorker(runner, allSolveCells, [], {
    tileTypes,
    maxTries: 5,
    initialCollapses,
    gridId: "BUILD_ALL",
    attemptNum: 1,
    watchCoords,
    watchAfterSteps,
  });
  const rustAttempt = engine.debug_legacy_trace_single_pass_once({
    seed: BigInt(seed),
    tile_types: null,
    wfc_mode: "legacy-compat",
    watch_coords: watchCoords,
    watch_after_steps: watchAfterSteps,
  });
  const rustProduction = normalizeSinglePassFixtureEnvelope(
    engine.solve_all_single_pass({
      seed: BigInt(seed),
      tile_types: null,
      wfc_mode: "legacy-compat",
    }),
    fixture,
  );

  const jsNormalized = normalizeTraceEnvelope({
    success: jsAttempt.success,
    trace: jsAttempt.trace ?? [],
    tiles: jsAttempt.tiles ?? [],
    collapseOrder: jsAttempt.collapseOrder ?? [],
    fixedCells: [],
    initialCollapses,
    backtracks: jsAttempt.backtracks ?? 0,
    tries: jsAttempt.tries ?? 0,
    watchedSnapshots: jsAttempt.watchedSnapshots ?? [],
    lastConflict: jsAttempt.lastConflict ?? null,
    neighborConflict: jsAttempt.neighborConflict ?? null,
  });
  const rustRaw = normalizeTraceEnvelope({
    success: rustAttempt.success,
    trace: rustAttempt.trace ?? [],
    tiles: rustAttempt.tiles ?? [],
    collapseOrder: rustAttempt.collapse_order ?? [],
    fixedCells: rustAttempt.fixed_cells ?? [],
    initialCollapses: rustAttempt.initial_collapses ?? [],
    backtracks: rustAttempt.backtracks ?? 0,
    watchedSnapshots: rustAttempt.watched_snapshots ?? [],
    lastConflict: rustAttempt.last_conflict ?? null,
    neighborConflict: rustAttempt.neighbor_conflict ?? null,
    tries: rustAttempt.tries ?? 0,
  });
  const rustNormalized = rustAttempt.normalized_result
    ? normalizeSinglePassFixtureEnvelope(rustAttempt.normalized_result, fixture)
    : null;
  const normalizedTarget = normalizeExpectedSinglePassFixture(fixture);

  reportTraceComparison({
    label: `seed ${seed} single-pass`,
    jsNormalized,
    rustRaw,
    normalizedTarget,
    rustNormalized,
    rustProduction,
  });
}

async function primeProgressivePrefix(runner, engine, fixture, grids, seed, untilIndex) {
  for (let index = 0; index < untilIndex; index += 1) {
    const expected = normalizeGridForCompare(fixture.grids[index]);
    const jsGrid = normalizeGridForCompare(await runner.solveProgressiveGrid(grids[index]));
    const rustGrid = normalizeGridForCompare(
      engine.solve_grid({
        seed: BigInt(seed),
        grid_q: grids[index].gridQ,
        grid_r: grids[index].gridR,
        tile_types: null,
        wfc_mode: "legacy-compat",
      }),
    );

    const jsMismatch = firstMismatchPath(expected, jsGrid);
    if (jsMismatch) {
      throw new Error(`JS prefix diverged from fixture at grid ${index}: ${jsMismatch}`);
    }
    const rustMismatch = firstMismatchPath(expected, rustGrid);
    if (rustMismatch) {
      throw new Error(`Rust prefix diverged from fixture at grid ${index}: ${rustMismatch}`);
    }
  }
}

async function traceWithWorker(runner, solveCells, fixedCells, options) {
  await runner.ensureWorker(0);
  const worker = runner.worker;
  if (!worker) {
    throw new Error("legacy worker not initialized");
  }

  const id = `trace_${Date.now()}_${++runner.requestId}`;
  return new Promise((resolve, reject) => {
    runner.pending.set(id, {
      resolve(message) {
        if (message.type === "trace-error") {
          reject(new Error(message.error ?? "trace worker error"));
          return;
        }
        resolve(message);
      },
      reject,
    });
    worker.postMessage({
      type: "trace-solve",
      id,
      solveCells,
      fixedCells,
      options,
    });
  });
}

function cloneTile(tile) {
  return {
    q: tile.q,
    r: tile.r,
    s: tile.s,
    type: tile.type,
    rotation: tile.rotation,
    level: tile.level,
  };
}

function normalizeGridForCompare(grid) {
  return {
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

function normalizeExpectedSinglePassFixture(fixture) {
  return {
    status: fixture.status,
    grids: fixture.grids.map((grid) => ({
      gridQ: grid.gridQ,
      gridR: grid.gridR,
      gridS: grid.gridS ?? (-grid.gridQ - grid.gridR),
      gridX: grid.gridX,
      gridZ: grid.gridZ,
      result: normalizeGridForCompare(grid),
    })),
  };
}

function normalizeSinglePassFixtureEnvelope(result, fixture) {
  const buckets = bucketSinglePassResult(result, fixture.grids);
  return {
    status: result.status,
    grids: buckets.map((grid) => ({
      gridQ: grid.gridQ,
      gridR: grid.gridR,
      gridS: grid.gridS ?? (-grid.gridQ - grid.gridR),
      gridX: grid.gridX,
      gridZ: grid.gridZ,
      result: normalizeGridForCompare({
        ...grid,
        status: result.status,
        tiles: grid.tiles,
        collapse_order: grid.collapseOrder,
        changed_fixed_cells: [],
        unfixed_cells: [],
        dropped_cells: [],
        last_conflict: result.last_conflict ?? result.lastConflict ?? null,
        neighbor_conflict: result.neighbor_conflict ?? result.neighborConflict ?? null,
        tries: result.tries ?? 0,
        backtracks: result.backtracks ?? 0,
        local_wfc_attempts: result.local_wfc_attempts ?? 0,
        dropped_count: result.dropped_count ?? 0,
      }),
    })),
  };
}

function normalizeTraceEnvelope(result) {
  return {
    success: Boolean(result.success),
    tiles: normalizeTiles(result.tiles ?? [], true),
    collapseOrder: normalizeTiles(result.collapseOrder ?? result.collapse_order ?? []),
    fixedCells: normalizeTiles(result.fixedCells ?? result.fixed_cells ?? [], true),
    initialCollapses: normalizeTiles(result.initialCollapses ?? result.initial_collapses ?? [], true),
    trace: normalizeTrace(result.trace ?? []),
    lastConflict: normalizeConflict(result.lastConflict ?? result.last_conflict ?? null),
    neighborConflict: normalizeConflict(result.neighborConflict ?? result.neighbor_conflict ?? null),
    backtracks: result.backtracks ?? 0,
    tries: result.tries ?? 0,
    watched_snapshots: normalizeWatchedSnapshots(result.watchedSnapshots ?? result.watched_snapshots ?? []),
  };
}

function reportTraceComparison({
  label,
  jsNormalized,
  rustRaw,
  normalizedTarget,
  rustNormalized,
  rustProduction,
}) {
  const rawTraceMismatch = firstMismatchPathPreferContent(
    compactTrace(stripDecisionDepth(jsNormalized.trace)),
    compactTrace(stripDecisionDepth(rustRaw.trace)),
    "$.raw.trace",
  );
  const rawMismatch = rawTraceMismatch
    ?? firstMismatchPath(
      omitTrace(jsNormalized),
      omitTrace(rustRaw),
      "$.raw",
    );
  const normalizedMismatch = rustNormalized
    ? firstMismatchPath(normalizedTarget, rustNormalized, "$.normalized")
    : "$.normalized: missing normalized_result";
  const productionMismatch = firstMismatchPath(normalizedTarget, rustProduction, "$.production");

  if (rawMismatch || normalizedMismatch || productionMismatch) {
    if (rawMismatch) {
      console.error(`[trace:raw] ${label}: ${rawMismatch}`);
    }
    if (normalizedMismatch) {
      console.error(`[trace:normalized] ${label}: ${normalizedMismatch}`);
    }
    if (productionMismatch) {
      console.error(`[trace:production] ${label}: ${productionMismatch}`);
    }
    const eventIndex = extractTraceIndex(rawMismatch);
    if (eventIndex !== null) {
      for (let index = Math.max(0, eventIndex - 2); index <= Math.min(jsNormalized.trace.length - 1, eventIndex + 2); index += 1) {
        console.error(`[trace] js[${index}] ${JSON.stringify(jsNormalized.trace[index], null, 2)}`);
        console.error(`[trace] rs[${index}] ${JSON.stringify(rustRaw.trace[index], null, 2)}`);
      }
    }
    if (jsNormalized.watched_snapshots.length > 0 || rustRaw.watched_snapshots.length > 0) {
      console.error(`[watch] js ${JSON.stringify(jsNormalized.watched_snapshots, null, 2)}`);
      console.error(`[watch] rs ${JSON.stringify(rustRaw.watched_snapshots, null, 2)}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`trace matched for ${label}; raw=${jsNormalized.trace.length} normalized/prod matched fixture`);
}

function normalizeTrace(trace) {
  return trace.map((event) => ({
    step: event.step,
    kind: event.kind,
    rng_calls: event.rng_calls ?? event.rngCalls ?? 0,
    target: normalizeCoord(event.target),
    chosen: normalizeTraceState(event.chosen),
    conflict: normalizeConflict(event.conflict),
    collapse_order_len: event.collapse_order_len ?? event.collapseOrderLen ?? 0,
    remaining_possibilities: event.remaining_possibilities ?? event.remainingPossibilities ?? null,
    available_states: normalizeTraceStates(event.available_states ?? event.availableStates ?? []),
    tried_states: normalizeTraceStates(event.tried_states ?? event.triedStates ?? []),
    decision_depth: event.decision_depth ?? event.decisionDepth ?? 0,
  }));
}

function stripDecisionDepth(trace) {
  return trace.map(({ decision_depth, ...event }) => event);
}

function compactTrace(trace) {
  return trace.map((event) => ({
    step: event.step,
    kind: event.kind,
    rng_calls: event.rng_calls,
    target: event.target,
    chosen: event.chosen,
    conflict: event.conflict,
    collapse_order_len: event.collapse_order_len,
    remaining_possibilities: event.remaining_possibilities,
    available_states_count: Array.isArray(event.available_states) ? event.available_states.length : 0,
    tried_states_count: Array.isArray(event.tried_states) ? event.tried_states.length : 0,
  }));
}

function normalizeWatchedSnapshots(snapshots) {
  return snapshots.map((snapshot) => ({
    step: snapshot.step,
    cells: (snapshot.cells ?? []).map(normalizeWatchedCell),
  }));
}

function normalizeWatchedCell(cell) {
  return {
    coord: normalizeCoord(cell.coord),
    is_in_cells: Boolean(cell.is_in_cells ?? cell.isInCells),
    is_in_fixed: Boolean(cell.is_in_fixed ?? cell.isInFixed),
    collapsed: Boolean(cell.collapsed),
    tile: normalizeTraceState(cell.tile),
    possibilities: normalizeTraceStates(cell.possibilities ?? []).sort(compareTraceStateLike),
    possibility_order: normalizeTraceStates(cell.possibility_order ?? cell.possibilityOrder ?? []),
  };
}

function normalizeTiles(tiles, sort = false) {
  const normalized = tiles.map((tile) => ({
    q: tile.q,
    r: tile.r,
    s: tile.s ?? (-tile.q - tile.r),
    type: tile.type ?? tile.tile_id ?? tile.tileId,
    rotation: tile.rotation,
    level: tile.level,
  }));
  return sort ? normalized.sort(compareTileLike) : normalized;
}

function normalizeCoords(coords, sort = false) {
  const normalized = coords.map(normalizeCoord);
  return sort ? normalized.sort(compareCoordLike) : normalized;
}

function normalizeCoord(coord) {
  if (!coord) {
    return null;
  }
  return {
    q: coord.q,
    r: coord.r,
    s: coord.s ?? (-coord.q - coord.r),
  };
}

function normalizeTraceState(state) {
  if (!state) {
    return null;
  }
  return {
    tile_id: state.tile_id ?? state.type,
    rotation: state.rotation,
    level: state.level ?? 0,
  };
}

function normalizeTraceStates(states) {
  return states.map(normalizeTraceState);
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
    dir: normalizeDir(conflict.dir),
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
  return normalizeCoord({ q, r });
}

function cubeKey(q, r, s = -q - r) {
  return `${q},${r},${s}`;
}

function compareTraceStateLike(left, right) {
  return (left.tile_id ?? 0) - (right.tile_id ?? 0)
    || (left.rotation ?? 0) - (right.rotation ?? 0)
    || (left.level ?? 0) - (right.level ?? 0);
}

function normalizeDir(dir) {
  if (typeof dir === "number" || dir === null || dir === undefined) {
    return dir ?? null;
  }
  const dirNames = ["NE", "E", "SE", "SW", "W", "NW"];
  const index = dirNames.indexOf(dir);
  return index === -1 ? dir : index;
}

function compareTileLike(left, right) {
  return compareCoordLike(left, right)
    || left.type - right.type
    || left.rotation - right.rotation
    || left.level - right.level;
}

function compareCoordLike(left, right) {
  return left.q - right.q || left.r - right.r || left.s - right.s;
}

function firstMismatchPath(expected, actual, pathPrefix = "$") {
  if (expected === actual) {
    return null;
  }
  if (expected === null || actual === null || typeof expected !== "object" || typeof actual !== "object") {
    return `${pathPrefix}: ${JSON.stringify(expected)} !== ${JSON.stringify(actual)}`;
  }
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      return `${pathPrefix}: ${JSON.stringify(expected)} !== ${JSON.stringify(actual)}`;
    }
    if (expected.length !== actual.length) {
      return `${pathPrefix}.length: ${expected.length} !== ${actual.length}`;
    }
    for (let index = 0; index < expected.length; index += 1) {
      const mismatch = firstMismatchPath(expected[index], actual[index], `${pathPrefix}[${index}]`);
      if (mismatch) {
        return mismatch;
      }
    }
    return null;
  }

  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const key of [...keys].sort()) {
    if (!(key in expected) || !(key in actual)) {
      return `${pathPrefix}.${key}: ${JSON.stringify(expected[key])} !== ${JSON.stringify(actual[key])}`;
    }
    const mismatch = firstMismatchPath(expected[key], actual[key], `${pathPrefix}.${key}`);
    if (mismatch) {
      return mismatch;
    }
  }
  return null;
}

function firstMismatchPathPreferContent(expected, actual, pathPrefix = "$") {
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const sharedLength = Math.min(expected.length, actual.length);
    for (let index = 0; index < sharedLength; index += 1) {
      const mismatch = firstMismatchPath(expected[index], actual[index], `${pathPrefix}[${index}]`);
      if (mismatch) {
        return mismatch;
      }
    }
    if (expected.length !== actual.length) {
      return `${pathPrefix}.length: ${expected.length} !== ${actual.length}`;
    }
    return null;
  }
  return firstMismatchPath(expected, actual, pathPrefix);
}

function omitTrace(result) {
  const { trace, ...rest } = result;
  return rest;
}

function extractTraceIndex(mismatch) {
  if (!mismatch) {
    return null;
  }
  const match = mismatch.match(/^\$\.raw\.trace\[(\d+)\]/);
  return match ? Number(match[1]) : null;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
