// Load test: N concurrent one-shot jobs, assert caps hold and nothing is lost.
// Usage: node scripts/load-test.mjs [base] [n]   (defaults: http://localhost:3000, 12)
// Exits non-zero when an assertion fails. Latencies are poll-observed
// (poll interval 500ms), so they are upper bounds, not server timings.
const BASE = process.argv[2] || "http://localhost:3000";
const N = Number(process.argv[3] || 12);
const TYPES = ["summary", "notes", "quiz", "qa"];

const post = async (p, body) => {
  const r = await fetch(BASE + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p} -> ${r.status} ${d.error || ""}`);
  return d;
};
const get = async (p) => {
  const r = await fetch(BASE + p);
  return r.json();
};

const health0 = await get("/api/health");
const caps = health0.caps;
console.log(`caps: max_running=${caps.MAX_RUNNING} per_user=${caps.PER_USER_RUNNING} queue_max=${caps.QUEUE_MAX}`);

const t0 = Date.now();
const jobs = await Promise.all(Array.from({ length: N }, (_, i) =>
  post("/api/jobs", { videoId: `v${(i % 6) + 1}`, type: TYPES[i % TYPES.length], question: TYPES[i % TYPES.length] === "qa" ? "这个视频讲了什么？" : undefined })));
const submitted = new Map(jobs.map((j) => [j.id, Date.now()]));
let maxRunning = 0;
let doneAt = new Map();
const deadline = Date.now() + 90000;
let terminal = [];
while (Date.now() < deadline) {
  const h = await get("/api/health");
  maxRunning = Math.max(maxRunning, h.running);
  const all = await get("/api/jobs");
  const mine = all.filter((j) => submitted.has(j.id));
  for (const j of mine) {
    if (["done", "cancelled", "timeout", "failed", "interrupted"].includes(j.status) && !doneAt.has(j.id)) doneAt.set(j.id, Date.now());
  }
  terminal = mine.filter((j) => doneAt.has(j.id));
  if (terminal.length === N) break;
  await new Promise((r) => setTimeout(r, 500));
}
const totalMs = Date.now() - t0;
const latencies = [...doneAt.entries()].map(([id, t]) => t - submitted.get(id)).sort((a, b) => a - b);
const p50 = latencies[Math.floor(latencies.length * 0.5)] || 0;
const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;
const byStatus = {};
for (const j of terminal) byStatus[j.status] = (byStatus[j.status] || 0) + 1;
const report = { n: N, totalMs, throughputPerSec: Number((N / (totalMs / 1000)).toFixed(2)), maxRunningObserved: maxRunning, cap: caps.MAX_RUNNING, terminalCount: terminal.length, byStatus, latencyObservedMs: { p50, p95 } };
console.log(JSON.stringify(report, null, 2));
const ok = terminal.length === N && maxRunning <= caps.MAX_RUNNING && (byStatus.done || 0) >= N * 0.95;
if (!ok) { console.error("LOAD TEST FAILED"); process.exit(1); }
console.log("LOAD TEST PASSED");
