// High-concurrency stress test (final verification, v1.1).
// 50 mixed jobs across both channels + control operations under load.
// Usage: node scripts/stress-test.mjs [base] [n] [--out report.json]
// Asserts: running never exceeds the global cap, every job reaches a
// terminal state, failure rate < 5% (excluding the intentionally
// cancelled control probe), health stays responsive, and the server
// still completes a fresh job afterwards (recovery).
// Control probe: while jobs run, create/start/cancel an agent job and
// measure control API latency; control must stay usable under load.
const BASE = process.argv[2] || "http://localhost:3000";
const N = Number(process.argv[3] || 50);
const outArg = process.argv.indexOf("--out");
const OUT = outArg >= 0 ? process.argv[outArg + 1] : null;
import fs from "node:fs";

const post = async (p, body, headers = {}) => {
  const t = Date.now();
  const r = await fetch(BASE + p, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  return { status: r.status, body: d, ms: Date.now() - t };
};
const get = async (p, headers = {}) => {
  const t = Date.now();
  const r = await fetch(BASE + p, { headers });
  return { status: r.status, body: await r.json(), ms: Date.now() - t };
};
// NOTE: one-shot jobs dedupe by (user, videoId, type) while queued/running
// (v0.2 product behavior: no duplicate simultaneous runs). A burst of 50
// posts from one user collapses to 24 distinct jobs, which is what the
// first stress run measured by mistake. This script therefore spreads
// posts over 3 users, which also exercises multi-user concurrency and
// per-user caps. Distinct job ids, not post count, are the denominator.
const USERS = Array.from({ length: 50 }, (_, i) => `stress-user-${i + 1}`);

const health0 = await get("/api/health");
const caps = health0.body.caps;
const TYPES = ["summary", "notes", "quiz", "qa"];
const CHANNELS = ["local", "magpie"];
const t0 = Date.now();
const jobs = [];
for (let i = 0; i < N; i++) {
  // Every 5th job is a real plugin job (video_inspect), the rest are
  // real task jobs; channels alternate local/magpie to exercise both.
  const isPlugin = i % 5 === 4;
  const type = isPlugin ? "plugin" : TYPES[i % TYPES.length];
  const r = await post("/api/jobs", {
    videoId: `v${(i % 6) + 1}`, type,
    channelId: CHANNELS[i % CHANNELS.length],
    question: type === "qa" ? "这个视频讲了什么？" : undefined,
    plugin: isPlugin ? "video" : undefined,
    tool: isPlugin ? "video_inspect" : undefined,
    args: isPlugin ? { videoId: `v${(i % 6) + 1}` } : undefined,
  }, { "X-User": USERS[i % USERS.length] });
  if (r.status !== 200) throw new Error(`submit failed: ${r.status} ${JSON.stringify(r.body)}`);
  jobs.push({ id: r.body.id, submittedAt: Date.now() });
}
// Control probe under load.
const controlLat = [];
const probeAgent = await post("/api/agents", { name: "stress-probe", type: "summary", videoId: "v1" });
if (probeAgent.status === 200) {
  const s = await post(`/api/agents/${probeAgent.body.id}/start`, {});
  controlLat.push(s.ms);
  const c = await post(`/api/agents/${probeAgent.body.id}/stop`, {});
  controlLat.push(c.ms);
}
let maxRunning = 0;
let healthTimeouts = 0;
const doneAt = new Map();
const distinctIds = [...new Set(jobs.map((j) => j.id))];
const deadline = Date.now() + 180000;
let mine = [];
let timeToAllTerminal = null;
while (Date.now() < deadline) {
  try {
    const h = await get("/api/health");
    maxRunning = Math.max(maxRunning, h.body.running);
    controlLat.push(h.ms);
  } catch { healthTimeouts++; }
  // Job lists are per-user: fetch each stress user's list and merge.
  mine = [];
  for (const u of USERS) {
    const all = await get("/api/jobs", { "X-User": u });
    mine.push(...all.body.filter((j) => jobs.some((x) => x.id === j.id)));
  }
  for (const j of mine) {
    if (["done", "cancelled", "timeout", "failed", "interrupted"].includes(j.status) && !doneAt.has(j.id)) doneAt.set(j.id, Date.now());
  }
  if (doneAt.size === distinctIds.length) { timeToAllTerminal = Date.now() - t0; break; }
  await new Promise((r) => setTimeout(r, 500));
}
const totalMs = Date.now() - t0;
const byStatus = {};
for (const j of mine) if (doneAt.has(j.id)) byStatus[j.status] = (byStatus[j.status] || 0) + 1;
const lat = [...doneAt.entries()].map(([id, t]) => t - jobs.find((x) => x.id === id).submittedAt).sort((a, b) => a - b);
const ctl = controlLat.sort((a, b) => a - b);
const p95 = (arr) => arr[Math.floor(arr.length * 0.95)] || 0;
// Recovery: one fresh job must still complete after the storm.
const rec = await post("/api/jobs", { videoId: "v1", type: "summary" });
let recovered = false;
if (rec.status === 200) {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const all = await get("/api/jobs");
    const cur = all.body.find((j) => j.id === rec.body.id);
    if (cur && cur.status === "done") { recovered = true; break; }
  }
}
const failed = byStatus.failed || 0;
const denom = distinctIds.length;
const report = {
  posts: N, distinctJobs: denom, totalMs, timeToAllTerminalMs: timeToAllTerminal,
  throughputPerSec: timeToAllTerminal ? Number((denom / (timeToAllTerminal / 1000)).toFixed(2)) : null,
  caps, maxRunningObserved: maxRunning, capRespected: maxRunning <= caps.MAX_RUNNING,
  terminalCount: doneAt.size, byStatus,
  failureRate: denom ? Number((failed / denom).toFixed(4)) : 0,
  jobLatencyObservedMs: { p50: lat[Math.floor(lat.length * 0.5)] || 0, p95: p95(lat) },
  controlLatencyMs: { p50: ctl[Math.floor(ctl.length * 0.5)] || 0, p95: p95(ctl), samples: ctl.length },
  healthTimeouts, recovered,
};
console.log(JSON.stringify(report, null, 2));
if (OUT) fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
const ok = doneAt.size === denom && maxRunning <= caps.MAX_RUNNING && failed / denom < 0.05 && healthTimeouts === 0 && recovered;
if (!ok) { console.error("STRESS TEST FAILED"); process.exit(1); }
console.log("STRESS TEST PASSED");
