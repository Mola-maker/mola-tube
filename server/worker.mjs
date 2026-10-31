// v1.2 fork-mode worker: one child process per job. Thin wrapper over
// job-runner.mjs; the pool path (pool-worker.mjs) shares the same runner.
// Terminal messages use the flush-before-exit callback (see v1.1 notes).
import fs from "node:fs";
import path from "node:path";
import { runJob, CancelledError } from "./job-runner.mjs";

const done = (msg, code) => { if (process.send) process.send(msg, () => process.exit(code)); else process.exit(code); };

const assignment = {
  jobId: process.env.MOLATUBE_JOB_ID,
  agentId: process.env.MOLATUBE_AGENT_ID || "",
  type: process.env.MOLATUBE_TYPE,
  videoId: process.env.MOLATUBE_VIDEO_ID || "v1",
  question: process.env.MOLATUBE_QUESTION || "",
  plugin: process.env.MOLATUBE_PLUGIN || "",
  tool: process.env.MOLATUBE_TOOL || "",
  args: process.env.MOLATUBE_ARGS_JSON || "{}",
  workspace: process.env.MOLATUBE_WORKSPACE,
  user: process.env.MOLATUBE_USER || "demo-user",
};
if (!assignment.jobId || !assignment.workspace) {
  console.error("worker: missing MOLATUBE_JOB_ID / MOLATUBE_WORKSPACE");
  process.exit(2);
}
fs.mkdirSync(assignment.workspace, { recursive: true });
const ctx = {
  agent: assignment.agentId || "molatube",
  user: assignment.user,
  workspace: assignment.workspace,
  directory: path.resolve(import.meta.dirname, "data"),
};
let cancelled = false;
process.on("SIGTERM", () => { cancelled = true; });

try {
  const result = await runJob(assignment, ctx, {
    onProgress: (progress, step) => { if (process.send) process.send({ kind: "progress", progress, step }); },
    shouldCancel: () => cancelled,
  });
  done({ kind: "done", result }, 0);
} catch (e) {
  if (e instanceof CancelledError || e.code === "CANCELLED") done({ kind: "cancelled" }, 0);
  else { console.error(`worker failed: ${e.message}`); process.exit(1); }
}
