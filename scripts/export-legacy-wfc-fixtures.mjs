import fs from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";

export const DEFAULT_REPO_PATH = "/Users/kairyon/projects/hex-map-wfc";
export const GRID_RADIUS = 2;
export const TILE_RADIUS = 8;
export const LOCAL_SOLVE_RADIUS = 2;
export const MAX_LOCAL_ATTEMPTS = 5;
export const DEFAULT_PROGRESSIVE_SEEDS = [0, 1, 2, 10, 42];
export const DEFAULT_SINGLE_PASS_SEEDS = [0, 1, 2, 10, 42];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = parseMode(args.mode ?? "progressive");
  const repoPath = path.resolve(args.repo ?? DEFAULT_REPO_PATH);
  const outputPath = path.resolve(args.out ?? defaultOutputPath(mode));
  const seeds = parseSeeds(args.seeds ?? args.seed ?? defaultSeedsForMode(mode));

  const modules = await loadLegacyModules(repoPath);
  const fixtures = [];

  for (const seed of seeds) {
    const runner = new LegacyFixtureRunner(repoPath, modules);
    try {
      fixtures.push(await runner.export(seed, mode));
    } finally {
      await runner.dispose();
    }
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(
    outputPath,
    `${JSON.stringify({ schemaVersion: 1, source: "original-js", fixtures }, null, 2)}\n`,
    "utf8",
  );
  console.log(`wrote ${fixtures.length} fixture(s) to ${outputPath}`);
}

export function parseArgs(argv) {
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

export function parseSeeds(value) {
  return [...new Set(value
    .split(",")
    .map((seed) => seed.trim())
    .filter(Boolean)
    .map((seed) => {
      const parsed = Number(seed);
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`invalid seed: ${seed}`);
      }
      return parsed;
    }))];
}

export function parseMode(value) {
  if (value !== "progressive" && value !== "single-pass") {
    throw new Error(`invalid mode: ${value}`);
  }
  return value;
}

export function defaultOutputPath(mode) {
  return path.join("fixtures", `legacy-wfc-${mode}.json`);
}

export function defaultSeedsForMode(mode) {
  return (mode === "progressive" ? DEFAULT_PROGRESSIVE_SEEDS : DEFAULT_SINGLE_PASS_SEEDS).join(",");
}

export async function loadLegacyModules(repoPath, instanceKey = "default") {
  const importFromRepo = async (relativePath) => {
    const url = pathToFileURL(path.join(repoPath, relativePath));
    url.searchParams.set("instance", instanceKey);
    return import(url.href);
  };

  const seed = await importFromRepo("src/SeededRandom.js");
  const core = await importFromRepo("src/hexmap/HexWFCCore.js");
  const grid = await importFromRepo("src/hexmap/HexGridConnector.js");
  const tile = await importFromRepo("src/hexmap/HexTileData.js");

  return { seed, core, grid, tile };
}

export class LegacyFixtureRunner {
  constructor(repoPath, modules) {
    this.repoPath = repoPath;
    this.modules = modules;
    this.worker = null;
    this.requestId = 0;
    this.pending = new Map();
    this.globalCells = new Map();
    this.waterSideIndex = null;
  }

  async export(seed, mode) {
    this.globalCells.clear();
    this.waterSideIndex = null;
    this.modules.seed.setSeed(seed);
    await this.ensureWorker(seed);

    const grids = this.sortedGridCoords().map((coord) => ({
      gridQ: coord.q,
      gridR: coord.r,
      gridS: coord.s,
      gridX: coord.gridX,
      gridZ: coord.gridZ,
      center: this.gridCenter(coord.gridX, coord.gridZ),
    }));

    const fixture = {
      seed,
      mode,
      repoPath: this.repoPath,
      generatedAt: new Date().toISOString(),
      grids: [],
    };

    if (mode === "progressive") {
      for (const grid of grids) {
        fixture.grids.push(await this.solveProgressiveGrid(grid));
      }
      return fixture;
    }

    return this.solveSinglePassFixture(fixture, grids);
  }

  async dispose() {
    for (const pending of this.pending.values()) {
      pending.reject(new Error("legacy runner disposed"));
    }
    this.pending.clear();
    if (!this.worker) {
      return;
    }
    await this.worker.terminate();
    this.worker = null;
  }

  async ensureWorker(seed) {
    if (this.worker) {
      return;
    }
    const wrapperUrl = new URL("./legacy-wfc-worker-wrapper.mjs", import.meta.url);
    const workerModule = pathToFileURL(path.join(this.repoPath, "src/workers/wfc.worker.js")).href;
    this.worker = new Worker(wrapperUrl, {
      type: "module",
      workerData: { workerModule },
    });
    this.worker.on("message", (message) => this.onWorkerMessage(message));
    this.worker.on("error", (error) => this.onWorkerError(error));
    this.worker.postMessage({ type: "init", seed });
  }

  onWorkerMessage(message) {
    if (message.type === "log") {
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    pending.resolve(message);
  }

  onWorkerError(error) {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  async solveWithWorker(solveCells, fixedCells, options) {
    const id = `legacy_${++this.requestId}`;
    const worker = this.worker;
    if (!worker) {
      throw new Error("legacy worker not initialized");
    }

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({
        type: "solve",
        id,
        solveCells,
        fixedCells,
        options,
      });
    });
  }

  sortedGridCoords() {
    const coords = [];
    for (let q = -GRID_RADIUS; q <= GRID_RADIUS; q += 1) {
      for (let r = -GRID_RADIUS; r <= GRID_RADIUS; r += 1) {
        const s = -q - r;
        if (Math.max(Math.abs(q), Math.abs(r), Math.abs(s)) > GRID_RADIUS) {
          continue;
        }
        coords.push({
          q,
          r,
          s,
          gridX: q,
          gridZ: r + Math.floor((q - (q & 1)) / 2),
        });
      }
    }
    coords.sort((left, right) =>
      hexDistance(left, { q: 0, r: 0, s: 0 }) - hexDistance(right, { q: 0, r: 0, s: 0 })
      || left.q - right.q
      || left.r - right.r
      || left.s - right.s);
    return coords;
  }

  gridCenter(gridX, gridZ) {
    const worldOffset = calculateWorldOffset(gridX, gridZ, TILE_RADIUS);
    return this.modules.grid.worldOffsetToGlobalCube(worldOffset);
  }

  solveCellsForCenter(center) {
    return this.modules.core.cubeCoordsInRadius(center.q, center.r, center.s, TILE_RADIUS);
  }

  getFixedCellsForRegion(solveCells) {
    const solveSet = new Set(solveCells.map((cell) => this.modules.core.cubeKey(cell.q, cell.r, cell.s)));
    const fixed = new Map();
    for (const cell of solveCells) {
      for (const dir of this.modules.core.CUBE_DIRS) {
        const neighbor = {
          q: cell.q + dir.dq,
          r: cell.r + dir.dr,
          s: cell.s + dir.ds,
        };
        const key = this.modules.core.cubeKey(neighbor.q, neighbor.r, neighbor.s);
        if (solveSet.has(key) || fixed.has(key)) {
          continue;
        }
        const existing = this.globalCells.get(key);
        if (!existing) {
          continue;
        }
        fixed.set(key, cloneTile(existing));
      }
    }
    return [...fixed.values()];
  }

  getAnchorsForCell(fixedCell, solveSet, fixedSet) {
    const anchors = [];
    for (const dir of this.modules.core.CUBE_DIRS) {
      const neighbor = {
        q: fixedCell.q + dir.dq,
        r: fixedCell.r + dir.dr,
        s: fixedCell.s + dir.ds,
      };
      const key = this.modules.core.cubeKey(neighbor.q, neighbor.r, neighbor.s);
      if (solveSet.has(key) || fixedSet.has(key)) {
        continue;
      }
      const existing = this.globalCells.get(key);
      if (existing) {
        anchors.push(cloneTile(existing));
      }
    }
    return anchors;
  }

  async runWfcAttempt(ctx) {
    ctx.attempt += 1;
    let activeFixed = ctx.fixedCells.filter((cell) => !cell.dropped);
    let activeSolveCells = ctx.solveCells;

    if (ctx.persistedUnfixedKeys.size > 0) {
      const anchorFixed = [];
      const anchorKeys = new Set();
      activeSolveCells = [...ctx.solveCells];
      const solveKeys = new Set(ctx.solveCells.map((cell) => this.modules.core.cubeKey(cell.q, cell.r, cell.s)));
      const fixedKeys = new Set(activeFixed.map((cell) => this.modules.core.cubeKey(cell.q, cell.r, cell.s)));

      for (const key of ctx.persistedUnfixedKeys) {
        const cube = this.modules.core.parseCubeKey(key);
        if (!solveKeys.has(key)) {
          activeSolveCells.push(cube);
          solveKeys.add(key);
        }

        const anchors = ctx.anchorMap.get(key) ?? [];
        for (const anchor of anchors) {
          const anchorKey = this.modules.core.cubeKey(anchor.q, anchor.r, anchor.s);
          if (fixedKeys.has(anchorKey) || solveKeys.has(anchorKey) || anchorKeys.has(anchorKey)) {
            continue;
          }
          anchorFixed.push(cloneTile(anchor));
          anchorKeys.add(anchorKey);
        }
      }

      activeFixed = activeFixed
        .filter((cell) => !ctx.persistedUnfixedKeys.has(this.modules.core.cubeKey(cell.q, cell.r, cell.s)))
        .concat(anchorFixed);
    }

    const activeNeighborCells = activeFixed
      .filter((cell) => !ctx.persistedUnfixedKeys.has(this.modules.core.cubeKey(cell.q, cell.r, cell.s)))
      .map((cell) => ({
        ...cloneTile(cell),
        anchors: (ctx.anchorMap.get(this.modules.core.cubeKey(cell.q, cell.r, cell.s)) ?? []).map(cloneTile),
      }));

    const result = await this.solveWithWorker(activeSolveCells, activeFixed, {
      tileTypes: ctx.tileTypes,
      maxTries: 2,
      initialCollapses: ctx.initialCollapses.map(cloneTile),
      gridId: ctx.gridKey,
      attemptNum: ctx.attempt,
      neighborCells: activeNeighborCells,
    });

    ctx.attempt += Math.max(0, ((result.tries ?? 1) - 1));

    if (result.success) {
      return {
        success: true,
        tiles: (result.tiles ?? []).map(normalizeTile),
        collapseOrder: (result.collapseOrder ?? []).map(normalizeTile),
        changedFixedCells: (result.changedFixedCells ?? []).map(normalizeTile),
        unfixedKeys: [...(result.unfixedKeys ?? [])],
        trace: result.trace ?? [],
        backtracks: result.backtracks ?? 0,
        tries: result.tries ?? 0,
      };
    }

    const failedUnfixed = result.unfixedKeys ?? [];
    for (const key of failedUnfixed) {
      if (ctx.persistedUnfixedKeys.has(key)) {
        continue;
      }
      ctx.persistedUnfixedKeys.add(key);
      const fixed = ctx.fixedCells.find((cell) => this.modules.core.cubeKey(cell.q, cell.r, cell.s) === key);
      if (fixed) {
        ctx.persistedUnfixedOriginals.set(key, cloneTile(fixed));
      }
    }

    const failedInfo = result.neighborConflict ?? result.lastConflict ?? null;
    return {
      success: false,
      isNeighborConflict: Boolean(result.neighborConflict),
      failedCell: failedInfo
        ? { q: failedInfo.failedQ, r: failedInfo.failedR, s: failedInfo.failedS }
        : null,
      sourceKey: failedInfo?.sourceKey ?? null,
      trace: result.trace ?? [],
      neighborConflict: normalizeConflict(result.neighborConflict),
      lastConflict: normalizeConflict(result.lastConflict),
      backtracks: result.backtracks ?? 0,
      tries: result.tries ?? 0,
    };
  }

  buildContext(grid) {
    const solveCells = this.solveCellsForCenter(grid.center);
    const fixedCells = this.getFixedCellsForRegion(solveCells);
    const initialCollapses = [];

    if (fixedCells.length === 0) {
      initialCollapses.push({
        q: grid.center.q,
        r: grid.center.r,
        s: grid.center.s,
        type: this.modules.tile.TileType.GRASS,
        rotation: 0,
        level: 0,
      });
      this.addWaterEdgeSeeds(initialCollapses, grid.center, TILE_RADIUS);
    }

    const solveSet = new Set(solveCells.map((cell) => this.modules.core.cubeKey(cell.q, cell.r, cell.s)));
    const fixedSet = new Set(fixedCells.map((cell) => this.modules.core.cubeKey(cell.q, cell.r, cell.s)));
    for (const seed of this.getMapCornerOceanSeeds()) {
      const key = this.modules.core.cubeKey(seed.q, seed.r, seed.s);
      if (solveSet.has(key) && !fixedSet.has(key)) {
        initialCollapses.push(seed);
      }
    }

    const anchorMap = new Map();
    for (const fixedCell of fixedCells) {
      const key = this.modules.core.cubeKey(fixedCell.q, fixedCell.r, fixedCell.s);
      anchorMap.set(key, this.getAnchorsForCell(fixedCell, solveSet, fixedSet));
    }

    return {
      gridKey: `${grid.gridQ},${grid.gridR}`,
      center: grid.center,
      solveCells,
      fixedCells,
      initialCollapses,
      tileTypes: this.modules.tile.TILE_LIST.map((_, index) => index),
      anchorMap,
      persistedUnfixedKeys: new Set(),
      persistedUnfixedOriginals: new Map(),
      attempt: 0,
    };
  }

  async solveProgressiveGrid(grid) {
    const ctx = this.buildContext(grid);
    const stats = { tries: 0, backtracks: 0, localWfcAttempts: 0, droppedCount: 0 };

    let result = null;
    let collapseOrder = [];
    let changedFixedCells = [];
    let unfixedKeys = [];
    const droppedFixedCubes = [];

    const initialResult = await this.runWfcAttempt(ctx);
    if (initialResult.success) {
      result = initialResult.tiles;
      collapseOrder = initialResult.collapseOrder;
      changedFixedCells = initialResult.changedFixedCells;
      unfixedKeys = initialResult.unfixedKeys;
      stats.tries += initialResult.tries;
      stats.backtracks += initialResult.backtracks;
    } else {
      stats.tries += initialResult.tries;
      stats.backtracks += initialResult.backtracks;

      let failedCell = initialResult.failedCell;
      let isNeighborConflict = initialResult.isNeighborConflict;
      let sourceKey = initialResult.sourceKey;
      const resolvedRegions = new Set();
      let localAttempts = 0;

      while (!result && localAttempts < MAX_LOCAL_ATTEMPTS) {
        if (!failedCell) {
          break;
        }

        let center = null;
        if (localAttempts === 0 && isNeighborConflict && sourceKey) {
          center = this.modules.core.parseCubeKey(sourceKey);
          resolvedRegions.add(sourceKey);
        } else {
          const candidates = ctx.fixedCells
            .filter((cell) => !cell.dropped && !resolvedRegions.has(this.modules.core.cubeKey(cell.q, cell.r, cell.s)))
            .sort((left, right) =>
              this.modules.core.cubeDistance(left.q, left.r, left.s, failedCell.q, failedCell.r, failedCell.s)
              - this.modules.core.cubeDistance(right.q, right.r, right.s, failedCell.q, failedCell.r, failedCell.s));
          if (candidates.length === 0) {
            break;
          }
          center = { q: candidates[0].q, r: candidates[0].r, s: candidates[0].s };
          resolvedRegions.add(this.modules.core.cubeKey(center.q, center.r, center.s));
        }

        localAttempts += 1;
        stats.localWfcAttempts += 1;

        const localSolveCells = this.modules.core
          .cubeCoordsInRadius(center.q, center.r, center.s, LOCAL_SOLVE_RADIUS)
          .filter((cell) => this.globalCells.has(this.modules.core.cubeKey(cell.q, cell.r, cell.s)));
        const localFixedCells = this.getFixedCellsForRegion(localSolveCells);
        const localResult = await this.solveWithWorker(localSolveCells, localFixedCells, {
          tileTypes: ctx.tileTypes,
          maxTries: 5,
          quiet: true,
        });
        if (!localResult.success || !localResult.tiles) {
          continue;
        }

        this.applyTileResults(localResult.tiles, "local-wfc");
        ctx.fixedCells = this.getFixedCellsForRegion(ctx.solveCells);
        const solveSet = new Set(ctx.solveCells.map((cell) => this.modules.core.cubeKey(cell.q, cell.r, cell.s)));
        const fixedSet = new Set(ctx.fixedCells.map((cell) => this.modules.core.cubeKey(cell.q, cell.r, cell.s)));
        ctx.anchorMap.clear();
        for (const fixedCell of ctx.fixedCells) {
          const key = this.modules.core.cubeKey(fixedCell.q, fixedCell.r, fixedCell.s);
          ctx.anchorMap.set(key, this.getAnchorsForCell(fixedCell, solveSet, fixedSet));
        }
        ctx.persistedUnfixedKeys.clear();
        ctx.persistedUnfixedOriginals.clear();

        const retry = await this.runWfcAttempt(ctx);
        if (retry.success) {
          result = retry.tiles;
          collapseOrder = retry.collapseOrder;
          changedFixedCells = retry.changedFixedCells;
          unfixedKeys = retry.unfixedKeys;
          stats.tries += retry.tries;
          stats.backtracks += retry.backtracks;
          break;
        }

        stats.tries += retry.tries;
        stats.backtracks += retry.backtracks;
        failedCell = retry.failedCell;
        isNeighborConflict = retry.isNeighborConflict;
        sourceKey = retry.sourceKey;
      }

      ctx.persistedUnfixedKeys.clear();
      ctx.persistedUnfixedOriginals.clear();
      while (!result) {
        const candidates = ctx.fixedCells.filter((cell) => !cell.dropped);
        if (candidates.length === 0) {
          break;
        }
        if (failedCell) {
          candidates.sort((left, right) =>
            this.modules.core.cubeDistance(left.q, left.r, left.s, failedCell.q, failedCell.r, failedCell.s)
            - this.modules.core.cubeDistance(right.q, right.r, right.s, failedCell.q, failedCell.r, failedCell.s));
        }

        const dropped = candidates[0];
        dropped.dropped = true;
        droppedFixedCubes.push({ q: dropped.q, r: dropped.r, s: dropped.s });
        stats.droppedCount += 1;

        const retry = await this.runWfcAttempt(ctx);
        if (retry.success) {
          result = retry.tiles;
          collapseOrder = retry.collapseOrder;
          changedFixedCells = retry.changedFixedCells;
          unfixedKeys = retry.unfixedKeys;
          stats.tries += retry.tries;
          stats.backtracks += retry.backtracks;
          break;
        }

        stats.tries += retry.tries;
        stats.backtracks += retry.backtracks;
        if (retry.failedCell) {
          failedCell = retry.failedCell;
        }
      }
    }

    if (!result) {
      return {
        gridQ: grid.gridQ,
        gridR: grid.gridR,
        gridS: grid.gridS,
        gridX: grid.gridX,
        gridZ: grid.gridZ,
        status: "failed",
        tiles: [],
        collapseOrder: [],
        changedFixedCells: [],
        unfixedCells: [],
        droppedCells: droppedFixedCubes,
        lastConflict: null,
        neighborConflict: null,
        stats,
      };
    }

    this.applyChangedFixedCells(changedFixedCells);
    this.applyPersistedUnfixedReplacements(ctx.persistedUnfixedOriginals, result);

    const unfixedSet = new Set([...unfixedKeys, ...ctx.persistedUnfixedKeys]);
    const tiles = unfixedSet.size === 0
      ? result
      : result.filter((tile) => !unfixedSet.has(this.modules.core.cubeKey(tile.q, tile.r, tile.s)));
    const order = unfixedSet.size === 0
      ? collapseOrder
      : collapseOrder.filter((tile) => !unfixedSet.has(this.modules.core.cubeKey(tile.q, tile.r, tile.s)));

    this.applyTileResults(tiles, ctx.gridKey);

    return {
      gridQ: grid.gridQ,
      gridR: grid.gridR,
      gridS: grid.gridS,
      gridX: grid.gridX,
      gridZ: grid.gridZ,
      status: "solved",
      tiles,
      collapseOrder: order,
      changedFixedCells,
      unfixedCells: [...unfixedSet].map((key) => this.modules.core.parseCubeKey(key)),
      droppedCells: droppedFixedCubes,
      lastConflict: null,
      neighborConflict: null,
      stats,
    };
  }

  async solveSinglePassFixture(baseFixture, grids) {
    const solveKeySet = new Set();
    const allSolveCells = [];
    for (const grid of grids) {
      for (const cell of this.solveCellsForCenter(grid.center)) {
        const key = this.modules.core.cubeKey(cell.q, cell.r, cell.s);
        if (solveKeySet.has(key)) {
          continue;
        }
        solveKeySet.add(key);
        allSolveCells.push(cell);
      }
    }

    const centerGrid = grids.find((grid) => grid.gridQ === 0 && grid.gridR === 0);
    const initialCollapses = [
      { q: centerGrid.center.q, r: centerGrid.center.r, s: centerGrid.center.s, type: this.modules.tile.TileType.GRASS, rotation: 0, level: 0 },
      ...this.getMapCornerOceanSeeds(),
    ];

    const result = await this.solveWithWorker(allSolveCells, [], {
      tileTypes: this.modules.tile.TILE_LIST.map((_, index) => index),
      weights: {},
      maxTries: 5,
      initialCollapses,
      gridId: "BUILD_ALL",
      attemptNum: 1,
    });

    if (!result.success) {
      return {
        ...baseFixture,
        status: "failed",
        grids: grids.map((grid) => ({
          gridQ: grid.gridQ,
          gridR: grid.gridR,
          gridS: grid.gridS,
          gridX: grid.gridX,
          gridZ: grid.gridZ,
          status: "failed",
          tiles: [],
          collapseOrder: [],
          changedFixedCells: [],
          unfixedCells: [],
          droppedCells: [],
          lastConflict: normalizeConflict(result.lastConflict),
          neighborConflict: normalizeConflict(result.neighborConflict),
          stats: {
            tries: result.tries ?? 0,
            backtracks: result.backtracks ?? 0,
            localWfcAttempts: 0,
            droppedCount: 0,
          },
        })),
      };
    }

    const tiles = (result.tiles ?? []).map(normalizeTile);
    const collapseOrder = (result.collapseOrder ?? []).map(normalizeTile);
    this.applyTileResults(tiles, "BUILD_ALL");

    const tileMap = new Map(tiles.map((tile) => [this.modules.core.cubeKey(tile.q, tile.r, tile.s), tile]));
    const orderBuckets = new Map();
    for (const tile of collapseOrder) {
      const key = this.modules.core.cubeKey(tile.q, tile.r, tile.s);
      const bucket = orderBuckets.get(key) ?? [];
      bucket.push(tile);
      orderBuckets.set(key, bucket);
    }

    return {
      ...baseFixture,
      status: "solved",
      grids: grids.map((grid) => {
        const gridCellKeys = new Set(this.solveCellsForCenter(grid.center).map((cell) => this.modules.core.cubeKey(cell.q, cell.r, cell.s)));
        const gridTiles = [...gridCellKeys]
          .map((key) => tileMap.get(key))
          .filter(Boolean);
        const gridOrder = collapseOrder.filter((tile) => gridCellKeys.has(this.modules.core.cubeKey(tile.q, tile.r, tile.s)));
        return {
          gridQ: grid.gridQ,
          gridR: grid.gridR,
          gridS: grid.gridS,
          gridX: grid.gridX,
          gridZ: grid.gridZ,
          status: "solved",
          tiles: gridTiles,
          collapseOrder: gridOrder,
          changedFixedCells: [],
          unfixedCells: [],
          droppedCells: [],
          lastConflict: normalizeConflict(result.lastConflict),
          neighborConflict: normalizeConflict(result.neighborConflict),
          stats: {
            tries: result.tries ?? 0,
            backtracks: result.backtracks ?? 0,
            localWfcAttempts: 0,
            droppedCount: 0,
          },
        };
      }),
    };
  }

  applyTileResults(tiles, gridKey) {
    for (const tile of tiles.map(normalizeTile)) {
      const key = this.modules.core.cubeKey(tile.q, tile.r, tile.s);
      const existing = this.globalCells.get(key);
      if (existing) {
        existing.type = tile.type;
        existing.rotation = tile.rotation;
        existing.level = tile.level;
        continue;
      }
      this.globalCells.set(key, { ...tile, gridKey });
    }
  }

  applyChangedFixedCells(changedFixedCells) {
    for (const changed of changedFixedCells) {
      const key = this.modules.core.cubeKey(changed.q, changed.r, changed.s);
      const existing = this.globalCells.get(key);
      if (!existing) {
        continue;
      }
      existing.type = changed.type;
      existing.rotation = changed.rotation;
      existing.level = changed.level;
    }
  }

  applyPersistedUnfixedReplacements(originals, solvedTiles) {
    const solvedMap = new Map(
      solvedTiles.map((tile) => [this.modules.core.cubeKey(tile.q, tile.r, tile.s), tile]),
    );
    for (const [key, original] of originals) {
      const solved = solvedMap.get(key);
      if (!solved) {
        continue;
      }
      if (solved.type === original.type && solved.rotation === original.rotation && solved.level === original.level) {
        continue;
      }
      const existing = this.globalCells.get(key);
      if (!existing) {
        continue;
      }
      existing.type = solved.type;
      existing.rotation = solved.rotation;
      existing.level = solved.level;
    }
  }

  addWaterEdgeSeeds(initialCollapses, center, radius) {
    const dirs = [
      { q: 1, r: -1, s: 0 },
      { q: 1, r: 0, s: -1 },
      { q: 0, r: 1, s: -1 },
      { q: -1, r: 1, s: 0 },
      { q: -1, r: 0, s: 1 },
      { q: 0, r: -1, s: 1 },
    ];
    this.waterSideIndex = Math.floor(this.modules.seed.random() * 6);
    const first = dirs[this.waterSideIndex];
    const second = dirs[(this.waterSideIndex + 1) % 6];
    const half = Math.floor(radius / 2);
    initialCollapses.push({
      q: center.q + first.q * (radius - half) + second.q * half,
      r: center.r + first.r * (radius - half) + second.r * half,
      s: center.s + first.s * (radius - half) + second.s * half,
      type: this.modules.tile.TileType.WATER,
      rotation: 0,
      level: 0,
    });
  }

  getMapCornerOceanSeeds() {
    const cubeDirs = [
      { q: 1, r: -1, s: 0 },
      { q: 1, r: 0, s: -1 },
      { q: 0, r: 1, s: -1 },
      { q: -1, r: 1, s: 0 },
      { q: -1, r: 0, s: 1 },
      { q: 0, r: -1, s: 1 },
    ];
    const gridCubeToOffset = (q, r) => [q, r + Math.floor((q - (q & 1)) / 2)];

    const direction = this.waterSideIndex ?? Math.floor(this.modules.seed.random() * 6);
    this.waterSideIndex = direction;

    const dir = cubeDirs[direction];
    const prevStep = cubeDirs[(direction + 4) % 6];
    const nextStep = cubeDirs[(direction + 2) % 6];
    const sideGrids = [
      gridCubeToOffset(dir.q * 2 + prevStep.q, dir.r * 2 + prevStep.r),
      gridCubeToOffset(dir.q * 2, dir.r * 2),
      gridCubeToOffset(dir.q * 2 + nextStep.q, dir.r * 2 + nextStep.r),
    ];
    const innerGrid = gridCubeToOffset(dir.q, dir.r);

    return [...sideGrids, innerGrid].map(([gridX, gridZ]) => {
      const center = this.gridCenter(gridX, gridZ);
      return {
        q: center.q,
        r: center.r,
        s: center.s,
        type: this.modules.tile.TileType.WATER,
        rotation: 0,
        level: 0,
      };
    });
  }
}

export function calculateWorldOffset(gridX, gridZ, gridRadius) {
  if (gridX === 0 && gridZ === 0) {
    return { x: 0, z: 0 };
  }

  const hexWidth = 2;
  const hexHeight = (2 / Math.sqrt(3)) * 2;
  let totalX = 0;
  let totalZ = 0;
  let currentX = 0;
  let currentZ = 0;

  while (currentX !== gridX || currentZ !== gridZ) {
    const dx = gridX - currentX;
    const dz = gridZ - currentZ;
    const isOddCol = Math.abs(currentX) % 2 === 1;

    let direction = null;
    let nextX = currentX;
    let nextZ = currentZ;

    if (dx === 0) {
      direction = dz < 0 ? 0 : 3;
      nextZ += dz < 0 ? -1 : 1;
    } else if (dx > 0) {
      if (dz < 0 || (dz === 0 && !isOddCol)) {
        direction = 1;
        nextX += 1;
        nextZ += isOddCol ? 0 : -1;
      } else {
        direction = 2;
        nextX += 1;
        nextZ += isOddCol ? 1 : 0;
      }
    } else if (dz < 0 || (dz === 0 && !isOddCol)) {
      direction = 5;
      nextX -= 1;
      nextZ += isOddCol ? 0 : -1;
    } else {
      direction = 4;
      nextX -= 1;
      nextZ += isOddCol ? 1 : 0;
    }

    const offset = getGridWorldOffset(gridRadius, direction, hexWidth, hexHeight);
    totalX += offset.x;
    totalZ += offset.z;
    currentX = nextX;
    currentZ = nextZ;
  }

  return { x: totalX, z: totalZ };
}

export function getGridWorldOffset(gridRadius, direction, hexWidth, hexHeight) {
  const diameter = gridRadius * 2 + 1;
  const gridWidth = diameter * hexWidth;
  const gridHeight = diameter * hexHeight * 0.75;
  const half = hexWidth * 0.5;

  const offsets = {
    0: { x: half, z: -gridHeight },
    1: { x: gridWidth * 0.75 + half * 0.5, z: -gridHeight * 0.5 + half * 0.866 },
    2: { x: gridWidth * 0.75 - half * 0.5, z: gridHeight * 0.5 + half * 0.866 },
    3: { x: -half, z: gridHeight },
    4: { x: -gridWidth * 0.75 - half * 0.5, z: gridHeight * 0.5 - half * 0.866 },
    5: { x: -gridWidth * 0.75 + half * 0.5, z: -gridHeight * 0.5 - half * 0.866 },
  };

  return offsets[direction];
}

export function normalizeTile(tile) {
  return {
    q: tile.q,
    r: tile.r,
    s: tile.s,
    type: tile.type,
    rotation: tile.rotation,
    level: tile.level,
  };
}

export function cloneTile(tile) {
  return {
    q: tile.q,
    r: tile.r,
    s: tile.s,
    type: tile.type,
    rotation: tile.rotation,
    level: tile.level,
    ...(tile.dropped ? { dropped: true } : {}),
  };
}

export function normalizeConflict(conflict) {
  if (!conflict) {
    return null;
  }
  const source = conflict.sourceKey ? parseCubeKey(conflict.sourceKey) : null;
  return {
    failedQ: conflict.failedQ,
    failedR: conflict.failedR,
    failedS: conflict.failedS,
    sourceQ: source?.q,
    sourceR: source?.r,
    sourceS: source?.s,
    sourceKey: conflict.sourceKey ?? null,
    dir: conflict.dir ?? null,
  };
}

export function parseCubeKey(key) {
  const [q, r, s] = key.split(",").map(Number);
  return { q, r, s };
}

export function hexDistance(left, right) {
  return (Math.abs(left.q - right.q) + Math.abs(left.r - right.r) + Math.abs(left.s - right.s)) / 2;
}

const isDirectRun = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;

if (isDirectRun) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
