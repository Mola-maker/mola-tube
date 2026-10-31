// Durable single-writer store for the v0.2 control plane.
// state.json = snapshot (agents + jobs). events.jsonl = append-only audit/event log.
// Every transition: mutate -> save snapshot -> append event -> broadcast (done by server).
import fs from "node:fs";
import path from "node:path";

export const DATA_DIR = path.resolve(import.meta.dirname, "data");
export const WORK_ROOT = path.resolve(import.meta.dirname, "workspaces");

export function initDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(WORK_ROOT, { recursive: true });
}

export function loadState() {
  const file = path.join(DATA_DIR, "state.json");
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    if (s && Array.isArray(s.agents) && Array.isArray(s.jobs)) return s;
  } catch { /* fresh state */ }
  return { agents: [], jobs: [] };
}

export function saveState(state) {
  const tmp = path.join(DATA_DIR, "state.json.tmp");
  const file = path.join(DATA_DIR, "state.json");
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

export function appendEvent(event) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n";
  fs.appendFileSync(path.join(DATA_DIR, "events.jsonl"), line);
  return line.trim();
}

export function loadEvents(limit = 200) {
  const file = path.join(DATA_DIR, "events.jsonl");
  try {
    const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
    return lines.slice(-limit);
  } catch { return []; }
}

// Path jail: a worker may only touch files inside its own workspace dir.
export function workspaceOf(jobId) {
  return path.join(WORK_ROOT, jobId);
}

export function jail(jobId, rel) {
  const full = path.resolve(workspaceOf(jobId), rel);
  if (full !== workspaceOf(jobId) && !full.startsWith(workspaceOf(jobId) + path.sep)) {
    throw new Error("path escape rejected");
  }
  return full;
}
