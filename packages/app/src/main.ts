import { WebGpuInitError } from "@hex/render";
import { WfcBridgeError } from "@hex/wfc";
import { boot } from "./orchestrator.js";

const canvas = document.querySelector<HTMLCanvasElement>("#viewport");
const statusElement = document.querySelector<HTMLElement>("#status");
const zoomElement = document.querySelector<HTMLElement>("#zoom");
const errorElement = document.querySelector<HTMLElement>("#error");
const errorMessageElement = document.querySelector<HTMLElement>("#error-message");

if (!canvas || !statusElement || !zoomElement || !errorElement || !errorMessageElement) {
  throw new Error("Application shell is incomplete.");
}

void boot(canvas, statusElement, zoomElement).catch((error) => {
  console.error("Application initialization failed:", error);
  statusElement.textContent = "Application initialization failed.";
  errorMessageElement.textContent = userFacingErrorMessage(error);
  errorElement.classList.add("visible");
});

function userFacingErrorMessage(error: unknown): string {
  if (error instanceof WebGpuInitError || error instanceof WfcBridgeError) {
    return error.userMessage;
  }

  return "The demo could not finish initializing. Reload the page and check the console for details.";
}
