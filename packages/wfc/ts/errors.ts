import type { WorkerFatalPhase } from "./types.js";

export type WfcBridgeErrorKind = "busy" | "disposed" | "fatal";

function defaultUserMessage(
  kind: WfcBridgeErrorKind,
  phase?: WorkerFatalPhase,
): string {
  if (kind === "busy") {
    return "Map generation is already running. Wait for it to finish and try again.";
  }

  if (kind === "disposed") {
    return "The map generator stopped before finishing. Reload the page and try again.";
  }

  if (phase === "init") {
    return "Failed to initialize the WFC worker. Try again, then reload if it keeps failing.";
  }

  return "The WFC worker stopped unexpectedly while generating the map. Try again, then reload if it keeps failing.";
}

export class WfcBridgeError extends Error {
  readonly kind: WfcBridgeErrorKind;
  readonly phase?: WorkerFatalPhase;
  readonly userMessage: string;

  constructor(
    kind: WfcBridgeErrorKind,
    message: string,
    options: {
      phase?: WorkerFatalPhase;
      userMessage?: string;
    } = {},
  ) {
    super(message);
    this.name = "WfcBridgeError";
    this.kind = kind;
    this.phase = options.phase;
    this.userMessage = options.userMessage ?? defaultUserMessage(kind, options.phase);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
