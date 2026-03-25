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
  const message = error instanceof Error ? error.message : String(error);
  statusElement.textContent = "Renderer initialization failed.";
  errorMessageElement.textContent = message;
  errorElement.classList.add("visible");
});
