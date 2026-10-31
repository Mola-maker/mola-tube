// v1.2 pool worker: one long-lived process serving many jobs in sequence.
// Plugins are imported ONCE at boot, so a job pays no fork cost and no
// plugin-import cost — the extreme-optimization half of v1.2. State is
// per-assignment (workspace jail + ctx), never shared between jobs; a
// worker is recycled by the parent after an error or a kill.
// Protocol: {kind:"run", job} / {kind:"cancel"} in; progress/done/failed/
// cancelled messages out, each tagged with the job id.
import path from "node:path";
import { loadPlugins, allPluginDirs } from "./plugins.mjs";
import { runJob, CancelledError } from "./job-runner.mjs";

const send = (msg) => { if (process.send) process.send(msg); };
let plugins = null;
try {
  plugins = await loadPlugins(allPluginDirs());
} catch (e) {
  console.error(`pool-worker failed to load plugins: ${e.message}`);
  process.exit(2);
}
let currentJobId = null;
let cancelled = false;

// Register the handler BEFORE announcing ready, so the parent can never
// send a run message into a worker with no listener (fork IPC drops those).
process.on("message", async (msg) => {
  if (msg.kind === "cancel") { cancelled = true; return; }
  if (msg.kind !== "run" || currentJobId) return;
  const assignment = msg.job;
  // The parent sends the job id as `id` (same shape as state.jobs).
  const jobId = assignment.id || assignment.jobId;
  currentJobId = jobId;
  cancelled = false;
  const ctx = {
    agent: assignment.agentId || "molatube",
    user: assignment.user || "demo-user",
    workspace: assignment.workspace,
    directory: path.resolve(import.meta.dirname, "data"),
  };
  try {
    const result = await runJob(assignment, ctx, {
      plugins,
      onProgress: (progress, step) => send({ kind: "progress", jobId, progress, step }),
      shouldCancel: () => cancelled,
    });
    send({ kind: "done", jobId, result });
  } catch (e) {
    if (e instanceof CancelledError || e.code === "CANCELLED") send({ kind: "cancelled", jobId });
    else send({ kind: "failed", jobId, error: String(e.message || e) });
  } finally {
    currentJobId = null;
    cancelled = false;
  }
});
send({ kind: "ready" });
