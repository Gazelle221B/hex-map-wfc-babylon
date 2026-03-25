import type {
  WorkerRequest,
  WorkerResponse,
  SolveResultData,
  PlacementData,
} from "./types.js";

type PendingResolve<T> = {
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
};

/**
 * Bridge between the main thread and the WFC WASM worker.
 * Provides a Promise-based API for grid solving and placement generation.
 */
export class WfcBridge {
  private worker: Worker;
  private pending = new Map<string, PendingResolve<unknown>>();
  private readyPromise: Promise<void>;
  private nextId = 0;

  constructor(seed: number) {
    this.worker = new Worker(
      new URL("./worker.ts", import.meta.url),
      { type: "module" },
    );

    this.readyPromise = new Promise<void>((resolve) => {
      const onReady = (event: MessageEvent<WorkerResponse>) => {
        if (event.data.type === "ready") {
          this.worker.removeEventListener("message", onReady);
          resolve();
        }
      };
      this.worker.addEventListener("message", onReady);
    });

    this.worker.addEventListener("message", this.onMessage);
    this.send({ type: "init", seed });
  }

  /** Wait for the WASM module to initialize. */
  async ready(): Promise<void> {
    return this.readyPromise;
  }

  /** Solve a single grid at the given hex-of-hex position. */
  async solveGrid(
    gridQ: number,
    gridR: number,
    tileTypes?: number[],
  ): Promise<SolveResultData> {
    const id = this.genId();
    return this.request<SolveResultData>({
      type: "solve",
      id,
      gridQ,
      gridR,
      tileTypes,
    }, id);
  }

  /** Solve all 19 grids. */
  async solveAll(seed: number): Promise<SolveResultData[]> {
    const id = this.genId();
    return this.request<SolveResultData[]>({
      type: "solveAll",
      id,
      seed,
    }, id);
  }

  /** Generate placements for a solved grid. */
  async generatePlacements(
    gridQ: number,
    gridR: number,
    seed: number,
    offsetX: number,
    offsetZ: number,
  ): Promise<PlacementData[]> {
    const id = this.genId();
    return this.request<PlacementData[]>({
      type: "placements",
      id,
      gridQ,
      gridR,
      seed,
      offsetX,
      offsetZ,
    }, id);
  }

  /** Reset the engine state. */
  reset(): void {
    this.send({ type: "reset" });
  }

  /** Terminate the worker. */
  dispose(): void {
    this.worker.removeEventListener("message", this.onMessage);
    this.worker.terminate();
    for (const { reject } of this.pending.values()) {
      reject(new Error("worker terminated"));
    }
    this.pending.clear();
  }

  private send(msg: WorkerRequest): void {
    this.worker.postMessage(msg);
  }

  private request<T>(msg: WorkerRequest, id: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.send(msg);
    });
  }

  private genId(): string {
    return String(++this.nextId);
  }

  private onMessage = (event: MessageEvent<WorkerResponse>): void => {
    const msg = event.data;

    switch (msg.type) {
      case "result": {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          p.resolve(msg.data);
        }
        break;
      }
      case "allResults": {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          p.resolve(msg.data);
        }
        break;
      }
      case "placements": {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          p.resolve(msg.data);
        }
        break;
      }
      case "error": {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          p.reject(new Error(msg.message));
        }
        break;
      }
    }
  };
}
