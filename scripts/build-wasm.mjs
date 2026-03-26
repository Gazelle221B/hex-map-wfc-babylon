#!/usr/bin/env node

import { spawn } from "node:child_process";

const mode = process.argv[2];

if (mode !== "dev" && mode !== "release") {
  console.error('Usage: node ./scripts/build-wasm.mjs <dev|release>');
  process.exit(1);
}

const wasmPath = mode === "release"
  ? "./target/wasm32-unknown-unknown/release/wfc_core.wasm"
  : "./target/wasm32-unknown-unknown/debug/wfc_core.wasm";

const steps = [
  {
    name: "cargo build",
    command: "cargo",
    args: [
      "build",
      ...(mode === "release" ? ["--release"] : []),
      "--target",
      "wasm32-unknown-unknown",
      "-p",
      "wfc-core",
    ],
  },
  {
    name: "wasm-bindgen",
    command: "wasm-bindgen",
    args: ["--target", "web", wasmPath, "--out-dir", "./packages/wfc/wasm"],
  },
  ...(mode === "release"
    ? [{
        name: "wasm-opt",
        command: "wasm-opt",
        args: [
          "-Oz",
          "--enable-bulk-memory",
          "--enable-nontrapping-float-to-int",
          "./packages/wfc/wasm/wfc_core_bg.wasm",
          "-o",
          "./packages/wfc/wasm/wfc_core_bg.wasm",
        ],
      }]
    : []),
];

for (const step of steps) {
  console.log(`[build:wasm:${mode}] ${step.name}`);
  await runStep(step.command, step.args, step.name);
}

console.log(`[build:wasm:${mode}] complete`);

function runStep(command, args, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
    });

    child.on("error", (error) => {
      if ("code" in error && error.code === "ENOENT") {
        reject(new Error(`${label} failed: '${command}' is not installed or not on PATH.`));
        return;
      }
      reject(new Error(`${label} failed to start: ${error.message}`));
    });

    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      if (signal) {
        reject(new Error(`${label} was terminated by signal ${signal}.`));
        return;
      }

      reject(new Error(`${label} exited with status ${code}.`));
    });
  }).catch((error) => {
    console.error(`[build:wasm:${mode}] ${error.message}`);
    process.exit(1);
  });
}
