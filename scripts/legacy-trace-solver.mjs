export class TraceHexWFCSolver {
  constructor(modules, rules, options = {}) {
    this.modules = modules;
    this.tile = modules.tile;
    this.seed = modules.seed;
    this.core = modules.core;
    this.rules = rules;
    this.options = {
      maxTries: options.maxTries ?? 2,
      tileTypes: options.tileTypes ?? null,
      attemptNum: options.attemptNum ?? 0,
      gridId: options.gridId ?? "",
      quiet: options.quiet ?? false,
    };
    this.cells = new Map();
    this.fixedCells = new Map();
    this.neighbors = new Map();
    this.propagationStack = [];
    this.tryCount = 0;
    this.lastConflict = null;
    this.neighborConflict = null;
    this.collapseOrder = [];
    this.trail = [];
    this.decisions = [];
    this.maxBacktracks = 500;
    this.backtracks = 0;
    this.neighborData = new Map();
    this.neighborOriginals = new Map();
    this.unfixedKeys = [];
    this.changedFixedCells = [];
    this.trace = [];
    this.rngCalls = 0;
    this.watchAfterSteps = new Set(options.watchAfterSteps ?? options.watch_after_steps ?? []);
    this.watchCoords = (options.watchCoords ?? options.watch_coords ?? []).map((coord) => ({
      q: coord.q,
      r: coord.r,
      s: coord.s ?? (-coord.q - coord.r),
    }));
    this.watchedSnapshots = [];
  }

  init(solveCells, fixedCells) {
    this.collapseOrder = [];
    const types = this.options.tileTypes ?? this.tile.TILE_LIST.map((_, index) => index);
    const allStates = [];
    for (const type of types) {
      const def = this.tile.TILE_LIST[type];
      if (!def) {
        continue;
      }
      const isSlope = def.highEdges && def.highEdges.length > 0;
      for (let rotation = 0; rotation < 6; rotation += 1) {
        if (isSlope) {
          const increment = def.levelIncrement ?? 1;
          const maxBaseLevel = this.tile.LEVELS_COUNT - 1 - increment;
          for (let level = 0; level <= maxBaseLevel; level += 1) {
            allStates.push({ type, rotation, level });
          }
        } else {
          for (let level = 0; level < this.tile.LEVELS_COUNT; level += 1) {
            allStates.push({ type, rotation, level });
          }
        }
      }
    }

    this.cells = new Map();
    for (const { q, r, s } of solveCells) {
      this.cells.set(this.core.cubeKey(q, r, s), new this.core.HexWFCCell(allStates));
    }

    this.fixedCells = new Map();
    for (const fixedCell of fixedCells) {
      const key = this.core.cubeKey(fixedCell.q, fixedCell.r, fixedCell.s);
      this.fixedCells.set(key, {
        type: fixedCell.type,
        rotation: fixedCell.rotation,
        level: fixedCell.level,
      });
    }

    this.neighbors = new Map();
    for (const { q, r, s } of solveCells) {
      const key = this.core.cubeKey(q, r, s);
      const neighbors = [];
      for (let index = 0; index < 6; index += 1) {
        const dir = this.core.CUBE_DIRS[index];
        const neighborKey = this.core.cubeKey(q + dir.dq, r + dir.dr, s + dir.ds);
        if (this.cells.has(neighborKey) || this.fixedCells.has(neighborKey)) {
          neighbors.push({
            key: neighborKey,
            dir: this.tile.HexDir[index],
            returnDir: this.tile.HexOpposite[this.tile.HexDir[index]],
          });
        }
      }
      this.neighbors.set(key, neighbors);
    }

    for (const fixedCell of fixedCells) {
      const key = this.core.cubeKey(fixedCell.q, fixedCell.r, fixedCell.s);
      const neighbors = [];
      for (let index = 0; index < 6; index += 1) {
        const dir = this.core.CUBE_DIRS[index];
        const neighborKey = this.core.cubeKey(
          fixedCell.q + dir.dq,
          fixedCell.r + dir.dr,
          fixedCell.s + dir.ds,
        );
        if (this.cells.has(neighborKey)) {
          neighbors.push({
            key: neighborKey,
            dir: this.tile.HexDir[index],
            returnDir: this.tile.HexOpposite[this.tile.HexDir[index]],
          });
        }
      }
      this.neighbors.set(key, neighbors);
    }

    this.propagationStack = [];
    this.noChainTypes = new Set();
    for (const type of types) {
      if (this.tile.TILE_LIST[type]?.preventChaining) {
        this.noChainTypes.add(type);
      }
    }
    for (const fixedCell of fixedCells) {
      if (this.noChainTypes.has(fixedCell.type)) {
        this.pruneChaining(this.core.cubeKey(fixedCell.q, fixedCell.r, fixedCell.s), fixedCell.type);
      }
    }
  }

  findLowestEntropyCell() {
    let minEntropy = Infinity;
    let minKey = null;
    for (const [key, cell] of this.cells) {
      if (!cell.collapsed && cell.possibilities.size > 0) {
        const entropy = Math.log(cell.possibilities.size) + this.random() * 0.001;
        if (entropy < minEntropy) {
          minEntropy = entropy;
          minKey = key;
        }
      }
    }
    return minKey;
  }

  pruneChaining(key, type) {
    const neighbors = this.neighbors.get(key);
    if (!neighbors) {
      return;
    }
    const prefix = `${type}_`;
    for (const { key: neighborKey } of neighbors) {
      const neighbor = this.cells.get(neighborKey);
      if (!neighbor || neighbor.collapsed) {
        continue;
      }
      for (const stateKey of [...neighbor.possibilities]) {
        if (stateKey.startsWith(prefix)) {
          neighbor.possibilities.delete(stateKey);
        }
      }
      if (neighbor.possibilities.size > 0) {
        this.propagationStack.push(neighborKey);
      }
    }
  }

  saveDecision(targetKey) {
    const cell = this.cells.get(targetKey);
    const decision = {
      targetKey,
      prevPossibilities: new Set(cell.possibilities),
      trailStart: this.trail.length,
      collapseOrderLen: this.collapseOrder.length,
      triedStates: new Set(),
    };
    this.decisions.push(decision);
    this.recordTrace({
      kind: "decision",
      target: this.traceCoord(this.core.parseCubeKey(targetKey)),
      chosen: null,
      conflict: null,
      collapse_order_len: this.collapseOrder.length,
      remaining_possibilities: cell.possibilities.size,
      available_states: [...cell.possibilities].map((stateKey) => this.traceStateFromKey(stateKey)),
      tried_states: [],
      decision_depth: this.decisions.length,
    });
  }

  undoLastDecision() {
    const decision = this.decisions[this.decisions.length - 1];
    if (!decision) {
      return null;
    }

    for (let index = this.trail.length - 1; index >= decision.trailStart; index -= 1) {
      const { key, stateKey } = this.trail[index];
      this.cells.get(key).possibilities.add(stateKey);
    }
    this.trail.length = decision.trailStart;

    const cell = this.cells.get(decision.targetKey);
    cell.possibilities = new Set(decision.prevPossibilities);
    cell.collapsed = false;
    cell.tile = null;

    this.collapseOrder.length = decision.collapseOrderLen;
    this.propagationStack = [];
    return decision;
  }

  collapseWithExclusions(key, excludeSet) {
    const cell = this.cells.get(key);
    const available = [...cell.possibilities].filter((stateKey) => !excludeSet.has(stateKey));
    if (available.length === 0) {
      return false;
    }

    const weights = available.map((stateKey) => {
      const state = this.core.HexWFCCell.parseKey(stateKey);
      return this.tile.TILE_LIST[state.type]?.weight ?? 1;
    });
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let randomValue = this.random() * total;
    let selectedKey = available[0];
    for (let index = 0; index < available.length; index += 1) {
      randomValue -= weights[index];
      if (randomValue <= 0) {
        selectedKey = available[index];
        break;
      }
    }

    excludeSet.add(selectedKey);
    const state = this.core.HexWFCCell.parseKey(selectedKey);
    cell.collapse(state);
    this.propagationStack.push(key);
    const { q, r, s } = this.core.parseCubeKey(key);
    this.collapseOrder.push({ q, r, s, type: state.type, rotation: state.rotation, level: state.level });
    this.recordTrace({
      kind: "collapse",
      target: this.traceCoord({ q, r, s }),
      chosen: this.traceState(state),
      conflict: null,
      collapse_order_len: this.collapseOrder.length,
      remaining_possibilities: null,
      available_states: [],
      tried_states: [...excludeSet].map((stateKey) => this.traceStateFromKey(stateKey)),
      decision_depth: this.decisions.length,
    });

    if (this.noChainTypes.has(state.type)) {
      this.pruneChaining(key, state.type);
    }

    return true;
  }

  backtrack() {
    this.backtracks += 1;
    if (this.backtracks >= this.maxBacktracks) {
      return false;
    }

    const decision = this.undoLastDecision();
    if (!decision) {
      return false;
    }

    const cell = this.cells.get(decision.targetKey);
    const available = [...cell.possibilities].filter((stateKey) => !decision.triedStates.has(stateKey));
    this.recordTrace({
      kind: "backtrack",
      target: this.traceCoord(this.core.parseCubeKey(decision.targetKey)),
      chosen: null,
      conflict: this.normalizeConflict(this.lastConflict),
      collapse_order_len: this.collapseOrder.length,
      remaining_possibilities: available.length,
      available_states: [],
      tried_states: [...decision.triedStates].map((stateKey) => this.traceStateFromKey(stateKey)),
      decision_depth: this.decisions.length,
    });

    if (available.length === 0) {
      this.decisions.pop();
      return this.backtrack();
    }

    return true;
  }

  propagate() {
    while (this.propagationStack.length > 0) {
      const key = this.propagationStack.pop();
      const cell = this.cells.get(key);
      const isFixed = !cell;
      let possibilities;

      if (isFixed) {
        const fixedCell = this.fixedCells.get(key);
        if (!fixedCell) {
          continue;
        }
        possibilities = new Set([this.core.HexWFCCell.stateKey(fixedCell)]);
      } else {
        possibilities = cell.possibilities;
      }

      const neighbors = this.neighbors.get(key);
      if (!neighbors) {
        continue;
      }

      for (const { key: neighborKey, dir, returnDir } of neighbors) {
        const neighbor = this.cells.get(neighborKey);
        if (!neighbor || neighbor.collapsed) {
          continue;
        }

        const allowedInNeighbor = new Set();
        const lookedUp = {};

        for (const stateKey of possibilities) {
          const edgeInfo = this.rules.stateEdges.get(stateKey)?.[dir];
          if (!edgeInfo) {
            continue;
          }

          const typeCache = lookedUp[edgeInfo.type];
          if (typeCache?.[edgeInfo.level]) {
            continue;
          }
          if (!typeCache) {
            lookedUp[edgeInfo.type] = {};
          }
          lookedUp[edgeInfo.type][edgeInfo.level] = true;

          const matches = this.rules.getByEdge(edgeInfo.type, returnDir, edgeInfo.level);
          for (const match of matches) {
            allowedInNeighbor.add(match);
          }
        }

        let changed = false;
        for (const neighborStateKey of [...neighbor.possibilities]) {
          if (!allowedInNeighbor.has(neighborStateKey)) {
            neighbor.possibilities.delete(neighborStateKey);
            this.trail.push({ key: neighborKey, stateKey: neighborStateKey });
            changed = true;
          }
        }

        if (neighbor.possibilities.size === 0) {
          const { q, r, s } = this.core.parseCubeKey(neighborKey);
          const failedOffset = this.core.cubeToOffset(q, r, s);
          this.lastConflict = {
            failedKey: neighborKey,
            failedQ: q,
            failedR: r,
            failedS: s,
            failedCol: failedOffset.col,
            failedRow: failedOffset.row,
            sourceKey: key,
            dir,
          };
          this.recordTrace({
            kind: "conflict",
            target: this.traceCoord({ q, r, s }),
            chosen: null,
            conflict: this.normalizeConflict(this.lastConflict),
            collapse_order_len: this.collapseOrder.length,
            remaining_possibilities: 0,
            available_states: [],
            tried_states: [],
            decision_depth: this.decisions.length,
          });
          return false;
        }

        if (changed) {
          this.propagationStack.push(neighborKey);
        }
      }
    }
    return true;
  }

  initNeighborData(neighborCells) {
    this.neighborData = new Map();
    this.neighborOriginals = new Map();
    this.unfixedKeys = [];
    this.changedFixedCells = [];
    if (!neighborCells) {
      return;
    }
    for (const cell of neighborCells) {
      const key = this.core.cubeKey(cell.q, cell.r, cell.s);
      this.neighborData.set(key, {
        q: cell.q,
        r: cell.r,
        s: cell.s,
        original: { type: cell.type, rotation: cell.rotation, level: cell.level },
        anchors: cell.anchors || [],
      });
      this.neighborOriginals.set(key, {
        q: cell.q,
        r: cell.r,
        s: cell.s,
        type: cell.type,
        rotation: cell.rotation,
        level: cell.level,
      });
    }
  }

  findAdjacentNeighbors(failedKey, sourceKey) {
    const candidates = [];
    if (sourceKey && this.fixedCells.has(sourceKey) && this.neighborData.has(sourceKey)) {
      candidates.push(sourceKey);
    }
    const { q, r, s } = this.core.parseCubeKey(failedKey);
    for (let index = 0; index < 6; index += 1) {
      const dir = this.core.CUBE_DIRS[index];
      const neighborKey = this.core.cubeKey(q + dir.dq, r + dir.dr, s + dir.ds);
      if (neighborKey !== sourceKey && this.fixedCells.has(neighborKey) && this.neighborData.has(neighborKey)) {
        candidates.push(neighborKey);
      }
    }
    return candidates;
  }

  unfixNeighbor(key, solveCells, fixedCells) {
    const softData = this.neighborData.get(key);
    if (!softData) {
      return;
    }
    const { q, r, s } = this.core.parseCubeKey(key);
    const fixedIndex = fixedCells.findIndex((cell) => this.core.cubeKey(cell.q, cell.r, cell.s) === key);
    if (fixedIndex !== -1) {
      fixedCells.splice(fixedIndex, 1);
    }
    if (!solveCells.some((cell) => this.core.cubeKey(cell.q, cell.r, cell.s) === key)) {
      solveCells.push({ q, r, s });
    }
    for (const anchor of softData.anchors) {
      const anchorKey = this.core.cubeKey(anchor.q, anchor.r, anchor.s);
      const alreadyFixed = fixedCells.some((cell) => this.core.cubeKey(cell.q, cell.r, cell.s) === anchorKey);
      const alreadySolve = solveCells.some((cell) => this.core.cubeKey(cell.q, cell.r, cell.s) === anchorKey);
      if (!alreadyFixed && !alreadySolve) {
        fixedCells.push({
          q: anchor.q,
          r: anchor.r,
          s: anchor.s,
          type: anchor.type,
          rotation: anchor.rotation,
          level: anchor.level,
        });
      }
    }
    this.neighborData.delete(key);
    this.unfixedKeys.push(key);
  }

  solve(solveCells, fixedCells, initialCollapses = []) {
    let currentSolveCells = [...solveCells];
    let currentFixedCells = [...fixedCells];
    let totalBacktracks = 0;

    for (let attempt = 1; attempt <= this.options.maxTries; attempt += 1) {
      this.init(currentSolveCells, currentFixedCells);
      this.trail = [];
      this.decisions = [];
      this.backtracks = 0;
      this.trace = [];
      this.rngCalls = 0;
      this.watchedSnapshots = [];

      for (const collapse of initialCollapses) {
        const key = this.core.cubeKey(collapse.q, collapse.r, collapse.s);
        const cell = this.cells.get(key);
        if (cell && !cell.collapsed) {
          const state = {
            type: collapse.type,
            rotation: collapse.rotation ?? 0,
            level: collapse.level ?? 0,
          };
          cell.collapse(state);
          this.collapseOrder.push({
            q: collapse.q,
            r: collapse.r,
            s: collapse.s,
            type: state.type,
            rotation: state.rotation,
            level: state.level,
          });
          this.propagationStack.push(key);
        }
      }

      for (const fixedCell of currentFixedCells) {
        this.propagationStack.push(this.core.cubeKey(fixedCell.q, fixedCell.r, fixedCell.s));
      }

      let neighborSeedingOk = true;
      if (currentFixedCells.length > 0 || initialCollapses.length > 0) {
        neighborSeedingOk = this.propagate();

        let maxUnfixes = this.neighborData.size;
        while (!neighborSeedingOk && maxUnfixes > 0) {
          maxUnfixes -= 1;
          const conflict = this.lastConflict;
          if (!conflict) {
            break;
          }
          const softCandidates = this.findAdjacentNeighbors(conflict.failedKey, conflict.sourceKey);
          if (softCandidates.length === 0) {
            break;
          }

          this.unfixNeighbor(softCandidates[0], currentSolveCells, currentFixedCells);
          this.init(currentSolveCells, currentFixedCells);
          this.trail = [];
          this.decisions = [];
          this.backtracks = 0;
          this.collapseOrder = [];
          this.trace = [];
          this.watchedSnapshots = [];

          for (const collapse of initialCollapses) {
            const key = this.core.cubeKey(collapse.q, collapse.r, collapse.s);
            const cell = this.cells.get(key);
            if (cell && !cell.collapsed) {
              const state = {
                type: collapse.type,
                rotation: collapse.rotation ?? 0,
                level: collapse.level ?? 0,
              };
              cell.collapse(state);
              this.collapseOrder.push({
                q: collapse.q,
                r: collapse.r,
                s: collapse.s,
                type: state.type,
                rotation: state.rotation,
                level: state.level,
              });
              this.propagationStack.push(key);
            }
          }

          for (const fixedCell of currentFixedCells) {
            this.propagationStack.push(this.core.cubeKey(fixedCell.q, fixedCell.r, fixedCell.s));
          }

          neighborSeedingOk = this.propagate();
        }
      }

      if (!neighborSeedingOk) {
        this.neighborConflict = this.lastConflict;
        return null;
      }

      let solved = false;
      let failed = false;
      while (true) {
        const targetKey = this.findLowestEntropyCell();
        if (!targetKey) {
          solved = true;
          break;
        }

        this.saveDecision(targetKey);
        const decision = this.decisions[this.decisions.length - 1];
        if (!this.collapseWithExclusions(targetKey, decision.triedStates)) {
          if (!this.backtrack()) {
            failed = true;
            break;
          }
          continue;
        }

        if (!this.propagate()) {
          if (!this.backtrack()) {
            failed = true;
            break;
          }
        }
      }

      totalBacktracks += this.backtracks;
      if (solved) {
        this.tryCount = attempt;
        this.backtracks = totalBacktracks;
        return this.extractResult();
      }
      if (failed) {
        this.tryCount = attempt;
      }
    }

    this.backtracks = totalBacktracks;
    return null;
  }

  extractResult() {
    const result = [];
    for (const [key, cell] of this.cells) {
      if (cell.tile) {
        const { q, r, s } = this.core.parseCubeKey(key);
        result.push({
          q,
          r,
          s,
          type: cell.tile.type,
          rotation: cell.tile.rotation,
          level: cell.tile.level,
        });
      }
    }

    this.changedFixedCells = [];
    for (const unfixedKey of this.unfixedKeys) {
      const cell = this.cells.get(unfixedKey);
      if (!cell?.tile) {
        continue;
      }
      const original = this.neighborOriginals.get(unfixedKey);
      if (!original) {
        continue;
      }
      if (
        cell.tile.type !== original.type
        || cell.tile.rotation !== original.rotation
        || cell.tile.level !== original.level
      ) {
        this.changedFixedCells.push({
          q: original.q,
          r: original.r,
          s: original.s,
          type: cell.tile.type,
          rotation: cell.tile.rotation,
          level: cell.tile.level,
        });
      }
    }

    return result;
  }

  recordTrace(event) {
    const step = this.trace.length;
    this.trace.push({
      step,
      kind: event.kind,
      rng_calls: this.rngCalls,
      target: event.target ?? null,
      chosen: event.chosen ?? null,
      conflict: event.conflict ?? null,
      collapse_order_len: event.collapse_order_len ?? 0,
      remaining_possibilities: event.remaining_possibilities ?? null,
      available_states: event.available_states ?? [],
      tried_states: event.tried_states ?? [],
      decision_depth: event.decision_depth ?? 0,
    });
    if (this.watchAfterSteps.has(step) && this.watchCoords.length > 0) {
      this.watchedSnapshots.push({
        step,
        cells: this.watchCoords.map((coord) => this.snapshotCell(coord)),
      });
    }
  }

  traceCoord(coord) {
    return { q: coord.q, r: coord.r, s: coord.s };
  }

  traceState(state) {
    return {
      tile_id: state.type,
      rotation: state.rotation,
      level: state.level ?? 0,
    };
  }

  traceStateFromKey(stateKey) {
    return this.traceState(this.core.HexWFCCell.parseKey(stateKey));
  }

  random() {
    this.rngCalls += 1;
    return this.seed.random();
  }

  snapshotCell(coord) {
    const key = this.core.cubeKey(coord.q, coord.r, coord.s);
    const cell = this.cells.get(key);
    if (cell) {
      const possibilityOrder = [...cell.possibilities].map((stateKey) => this.traceStateFromKey(stateKey));
      const possibilities = [...cell.possibilities]
        .slice()
        .sort()
        .map((stateKey) => this.traceStateFromKey(stateKey));
      return {
        coord: this.traceCoord(coord),
        is_in_cells: true,
        is_in_fixed: this.fixedCells.has(key),
        collapsed: cell.collapsed,
        tile: cell.tile ? this.traceState(cell.tile) : null,
        possibilities,
        possibility_order: possibilityOrder,
      };
    }

    const fixedCell = this.fixedCells.get(key);
    if (fixedCell) {
      const fixedState = this.traceState(fixedCell);
      return {
        coord: this.traceCoord(coord),
        is_in_cells: false,
        is_in_fixed: true,
        collapsed: true,
        tile: fixedState,
        possibilities: [fixedState],
        possibility_order: [fixedState],
      };
    }

    return {
      coord: this.traceCoord(coord),
      is_in_cells: false,
      is_in_fixed: false,
      collapsed: false,
      tile: null,
      possibilities: [],
      possibility_order: [],
    };
  }

  normalizeConflict(conflict) {
    if (!conflict) {
      return null;
    }
    const source = conflict.sourceKey ? this.core.parseCubeKey(conflict.sourceKey) : null;
    return {
      failedQ: conflict.failedQ,
      failedR: conflict.failedR,
      failedS: conflict.failedS,
      sourceQ: source?.q ?? null,
      sourceR: source?.r ?? null,
      sourceS: source?.s ?? null,
      dir: conflict.dir ?? null,
    };
  }
}
