// Magpie channel adapter: one process per job, between the control plane
// and worker.mjs. It speaks the Magpie tool-call envelope and enforces it:
// the call must name molatube.run_job and its arguments must validate
// against the tool's JSON Schema (type enum; videoId non-empty string for
// task jobs, plugin + tool for plugin jobs). v1.1 forwards the control
// plane's MOLATUBE_*/MAGPIE_* environment to the worker.
// Only then does it fork the real worker and relay its IPC messages up.
// This file IS the Magpie execution path in v1.0, not a label on top of
// the local path: the schema check and the tool-call audit record only
// exist here. A channel's endpoint field only records a remote host
// address for configuration; forwarding tool calls to a remote Magpie
// host is future work and is not claimed in v1.0.
import { fork } from "node:child_process";
import path from "node:path";

const TYPES = ["summary", "qa", "notes", "quiz", "plugin"];
const send = (msg) => { if (process.send) process.send(msg); };

let call;
try {
  call = JSON.parse(process.env.MOLATUBE_TOOL_CALL || "");
} catch {
  send({ kind: "error", error: "invalid tool-call envelope" });
  process.exit(2);
}
if (!call || call.tool !== "molatube.run_job" || !call.arguments) {
  send({ kind: "error", error: "tool must be molatube.run_job with arguments" });
  process.exit(2);
}
const { type, videoId, question, plugin, tool, args } = call.arguments;
if (!TYPES.includes(type)) {
  send({ kind: "error", error: "arguments failed schema validation (type enum)" });
  process.exit(2);
}
if (type === "plugin") {
  if (typeof plugin !== "string" || !plugin || typeof tool !== "string" || !tool) {
    send({ kind: "error", error: "plugin jobs need plugin + tool in arguments" });
    process.exit(2);
  }
} else if (typeof videoId !== "string" || !videoId) {
  send({ kind: "error", error: "arguments failed schema validation (videoId)" });
  process.exit(2);
}

// Forward the control plane's MOLATUBE_*/MAGPIE_* environment so the
// worker gets question, plugin fields, plugin dirs and layerfs home.
const forwarded = { PATH: process.env.PATH || "" };
for (const [k, v] of Object.entries(process.env)) {
  if (k.startsWith("MOLATUBE_") || k.startsWith("MAGPIE_")) forwarded[k] = v;
}
// Same flush-before-exit rule as the worker: the parent must receive the
// terminal message before this adapter exits, or the job is marked failed
// with "worker exited code 0" even though the work finished.
let pendingSend = false;
let workerCode = null;
let sawTerminal = false;
const tryExit = () => {
  if (workerCode !== null && !pendingSend) process.exit(sawTerminal ? 0 : workerCode);
};
const worker = fork(path.resolve(import.meta.dirname, "worker.mjs"), [], {
  env: {
    ...forwarded,
    MOLATUBE_TYPE: type,
    MOLATUBE_VIDEO_ID: videoId || "v1",
    MOLATUBE_QUESTION: question || "",
    MOLATUBE_PLUGIN: plugin || "",
    MOLATUBE_TOOL: tool || "",
    MOLATUBE_ARGS_JSON: JSON.stringify(args || {}),
  },
  execArgv: [`--max-old-space-size=${process.env.MOLATUBE_WORKER_MEM_MB || 256}`],
  stdio: ["ignore", "ignore", "ignore", "ipc"],
});
worker.on("message", (msg) => {
  if (msg.kind === "done" || msg.kind === "cancelled") {
    sawTerminal = true;
    pendingSend = true;
    // Flush the relayed message before exiting: process.send callback.
    if (process.send) process.send(msg, () => { pendingSend = false; tryExit(); });
    else { pendingSend = false; tryExit(); }
  } else send(msg);
});
worker.on("exit", (code) => {
  workerCode = code === 0 ? 0 : code || 1;
  // Same exit-before-message race as the control plane: give an
  // in-flight terminal message 200ms to arrive and be relayed.
  setTimeout(tryExit, 200);
});
process.on("SIGTERM", () => { try { worker.kill("SIGTERM"); } catch { /* gone */ } });
