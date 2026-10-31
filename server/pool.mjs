// Worker pool: N long-lived pool-worker processes. The parent assigns one
// job per worker; a worker serves jobs in sequence until it dies or is
// killed, then the parent replaces it (respawn happens exactly once per
// death, in the exit handler). A worker death mid-job fails that one job
// (the user retries manually, same as fork mode) and never the pool.
// kill() only signals; the exit handler owns removal + replacement, so a
// watchdog kill can never double-respawn. shutdown() suppresses replacement.
import { fork } from "node:child_process";
import path from "node:path";

export function createPool({ size, env, memMb, onMessage, onExit }) {
  let nextId = 1;
  let stopping = false;
  const workers = new Map(); // id -> {id, child, busyJobId, uses}
  const spawn = () => {
    const id = nextId++;
    const child = fork(path.resolve(import.meta.dirname, "pool-worker.mjs"), [], {
      env,
      execArgv: [`--max-old-space-size=${memMb}`],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const w = { id, child, busyJobId: null, uses: 0, ready: false };
    workers.set(id, w);
    child.on("message", (msg) => {
      // A worker is only assignable after it reports ready (plugins loaded
      // and its message handler registered). Assigning earlier loses the
      // run message: fork IPC drops messages with no listener, and the
      // job would sit "running" forever until its timeout.
      if (msg.kind === "ready") w.ready = true;
      onMessage(w, msg);
    });
    child.on("exit", (code) => {
      workers.delete(id);
      if (!stopping) onExit(w, code);
    });
    return w;
  };
  for (let i = 0; i < size; i++) spawn();
  return {
    size: () => workers.size,
    acquire() {
      for (const w of workers.values()) {
        if (w.ready && !w.busyJobId) return w;
      }
      return null;
    },
    assign(w, jobId) { w.busyJobId = jobId; w.uses += 1; },
    release(w) { w.busyJobId = null; },
    workerForJob(jobId) {
      for (const w of workers.values()) if (w.busyJobId === jobId) return w;
      return null;
    },
    respawn() { if (!stopping) return spawn(); return null; },
    kill(w, signal = "SIGKILL") {
      try { w.child.kill(signal); } catch { /* gone */ }
    },
    shutdown() {
      stopping = true;
      for (const w of [...workers.values()]) {
        try { w.child.kill("SIGTERM"); } catch { /* gone */ }
      }
      setTimeout(() => {
        for (const w of [...workers.values()]) {
          try { w.child.kill("SIGKILL"); } catch { /* gone */ }
        }
      }, 2000);
    },
    stats() {
      let busy = 0;
      for (const w of workers.values()) if (w.busyJobId) busy += 1;
      return { size: workers.size, busy, idle: workers.size - busy };
    },
  };
}
