// Magpie channel adapter: one process per job, between the control plane
// and worker.mjs. It speaks the Magpie tool-call envelope and enforces it:
// the call must name molatube.run_job and its arguments must validate
// against the tool's JSON Schema (type enum, videoId non-empty string).
// Only then does it fork the real worker and relay its IPC messages up.
// This file IS the Magpie execution path in v1.0, not a label on top of
// the local path: the schema check and the tool-call audit record only
// exist here. A channel's endpoint field only records a remote host
// address for configuration; forwarding tool calls to a remote Magpie
// host is future work and is not claimed in v1.0.
import { fork } from "node:child_process";
import path from "node:path";

const TYPES = ["summary", "qa", "notes", "quiz"];
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
const { type, videoId } = call.arguments;
if (!TYPES.includes(type) || typeof videoId !== "string" || !videoId) {
  send({ kind: "error", error: "arguments failed schema validation (type enum / videoId)" });
  process.exit(2);
}

const worker = fork(path.resolve(import.meta.dirname, "worker.mjs"), [], {
  env: {
    PATH: process.env.PATH || "",
    MOLATUBE_JOB_ID: process.env.MOLATUBE_JOB_ID,
    MOLATUBE_AGENT_ID: process.env.MOLATUBE_AGENT_ID || "",
    MOLATUBE_TYPE: type,
    MOLATUBE_VIDEO_ID: videoId,
    MOLATUBE_WORKSPACE: process.env.MOLATUBE_WORKSPACE,
  },
  execArgv: [`--max-old-space-size=${process.env.MOLATUBE_WORKER_MEM_MB || 256}`],
  stdio: ["ignore", "ignore", "ignore", "ipc"],
});
worker.on("message", (msg) => send(msg));
worker.on("exit", (code) => process.exit(code === 0 ? 0 : code || 1));
process.on("SIGTERM", () => { try { worker.kill("SIGTERM"); } catch { /* gone */ } });
