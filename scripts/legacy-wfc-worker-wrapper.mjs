import { parentPort, workerData } from "node:worker_threads";
import { TraceHexWFCSolver } from "./legacy-trace-solver.mjs";

if (!parentPort) {
  throw new Error("legacy-wfc-worker-wrapper must run in a worker thread");
}

globalThis.self = globalThis;
self.postMessage = (message) => {
  parentPort.postMessage(message);
};

const workerModuleUrl = new URL(workerData.workerModule);
let traceModulesPromise = null;

async function loadTraceModules() {
  if (!traceModulesPromise) {
    traceModulesPromise = Promise.all([
      import(new URL("../SeededRandom.js", workerModuleUrl)),
      import(new URL("../hexmap/HexWFCCore.js", workerModuleUrl)),
      import(new URL("../hexmap/HexTileData.js", workerModuleUrl)),
    ]).then(([seed, core, tile]) => ({ seed, core, tile }));
  }
  return traceModulesPromise;
}

async function handleTraceSolve(data) {
  const modules = await loadTraceModules();
  const rules = modules.core.HexWFCAdjacencyRules.fromTileDefinitions(data.options?.tileTypes ?? null);
  const solver = new TraceHexWFCSolver(modules, rules, data.options ?? {});
  solver.initNeighborData(data.options?.neighborCells);
  const result = solver.solve(
    data.solveCells ?? [],
    data.fixedCells ?? [],
    data.options?.initialCollapses ?? [],
  );

  parentPort.postMessage({
    type: "trace-result",
    id: data.id,
    success: result !== null,
    tiles: result,
    collapseOrder: solver.collapseOrder || [],
    neighborConflict: solver.neighborConflict,
    lastConflict: solver.lastConflict,
    changedFixedCells: solver.changedFixedCells || [],
    unfixedKeys: solver.unfixedKeys || [],
    backtracks: solver.backtracks || 0,
    tries: solver.tryCount || 0,
    trace: solver.trace || [],
    watchedSnapshots: solver.watchedSnapshots || [],
  });
}

parentPort.on("message", (data) => {
  if (data?.type === "trace-solve") {
    handleTraceSolve(data).catch((error) => {
      parentPort.postMessage({
        type: "trace-error",
        id: data.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return;
  }
  self.onmessage?.({ data });
});

await import(workerData.workerModule);
