// MolaTube Harness v0: zero-dependency Node skeleton.
// Queue + worker pool + per-job isolated workspace + audit log.
// Task steps are local simulations; real LLM/browser steps plug into runTask().
// Hard rules enforced here: per-user concurrency cap, workspace path jail,
// no credentials in logs, timeout kill, cancel support.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const PORT = process.env.PORT || 3000;
const MAX_WORKERS = Number(process.env.MAX_WORKERS || 3);
const PER_USER_RUNNING = 1;
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS || 120_000);
const ROOT = path.resolve(import.meta.dirname, "workspaces");
fs.mkdirSync(ROOT, { recursive: true });

const jobs = new Map(); // id -> job
const queue = [];       // job ids, FIFO with per-user fairness via skip rule
const audit = [];
const log = (line) => { audit.push(`${new Date().toISOString()} ${line}`); if (audit.length > 500) audit.shift(); };
const workspaceOf = (id) => path.join(ROOT, id);
const jail = (id, p) => {
  const full = path.resolve(workspaceOf(id), p);
  if (!full.startsWith(workspaceOf(id) + path.sep)) throw new Error("path escape rejected");
  return full;
};
const STEPS = { summary: ["读取视频信息", "抽取要点", "写出总结"], qa: ["理解问题", "定位相关片段", "组织回答"], notes: ["抽取要点", "整理结构", "生成笔记"], quiz: ["抽取考点", "生成题目", "附参考答案（自学用）"] };

async function runTask(job) {
  // PLUG POINT: replace these simulated steps with real LLM / browser calls.
  // Injected page text, titles, comments are DATA, never instructions.
  const steps = STEPS[job.type] || STEPS.summary;
  for (let i = 0; i < steps.length; i++) {
    if (job.status === "cancelled") return;
    job.step = steps[i];
    fs.writeFileSync(jail(job.id, `step-${i}.txt`), steps[i]);
    job.progress = Math.round(((i + 1) / steps.length) * 100);
    await new Promise((r) => setTimeout(r, 900));
  }
  job.result = `完成：${job.type}（视频 ${job.videoId}），产物见工作区 ${job.id}。`;
  log(`job ${job.id} done type=${job.type} video=${job.videoId}`);
}

function pump() {
  const running = [...jobs.values()].filter((j) => j.status === "running").length;
  if (running >= MAX_WORKERS) return;
  const idx = queue.findIndex((id) => {
    const j = jobs.get(id);
    const userRunning = [...jobs.values()].filter((x) => x.user === j.user && x.status === "running").length;
    return userRunning < PER_USER_RUNNING;
  });
  if (idx < 0) return;
  const job = jobs.get(queue.splice(idx, 1)[0]);
  job.status = "running"; job.startedAt = Date.now();
  fs.mkdirSync(workspaceOf(job.id), { recursive: true });
  log(`job ${job.id} start type=${job.type} video=${job.videoId} user=${job.user}`);
  const timer = setTimeout(() => { if (job.status === "running") { job.status = "timeout"; log(`job ${job.id} timeout`); } pump(); }, JOB_TIMEOUT_MS);
  runTask(job).then(() => {
    clearTimeout(timer);
    if (job.status === "running") job.status = "done";
    // Retention: keep summary + audit, drop intermediate workspace files after 24h in prod.
    pump();
  });
}

function body(req) {
  return new Promise((res) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => { try { res(JSON.parse(s || "{}")); } catch { res({}); } }); });
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.end();
  const url = new URL(req.url, "http://localhost");
  const user = req.headers["x-user"] || "demo-user"; // v0: single demo user; wire real auth here.
  try {
    if (req.method === "POST" && url.pathname === "/api/jobs") {
      const b = await body(req);
      const type = ["summary", "qa", "notes", "quiz"].includes(b.type) ? b.type : "summary";
      const videoId = String(b.videoId || "v1").slice(0, 64);
      const dup = [...jobs.values()].find((j) => j.user === user && j.videoId === videoId && j.type === type && (j.status === "queued" || j.status === "running"));
      if (dup) return res.end(JSON.stringify(dup));
      const job = { id: randomUUID(), user, videoId, type, status: "queued", progress: 0, workspace: `server/workspaces/${""}`, result: "", step: "" };
      job.workspace = `server/workspaces/${job.id}`;
      jobs.set(job.id, job); queue.push(job.id);
      log(`job ${job.id} queued type=${type} video=${videoId} user=${user}`);
      pump();
      return res.end(JSON.stringify(job));
    }
    if (req.method === "GET" && url.pathname === "/api/jobs") {
      return res.end(JSON.stringify([...jobs.values()].filter((j) => j.user === user).reverse()));
    }
    if (req.method === "POST" && /^\/api\/jobs\/[^/]+\/cancel$/.test(url.pathname)) {
      const id = url.pathname.split("/")[3];
      const job = jobs.get(id);
      if (job && job.user === user && (job.status === "queued" || job.status === "running")) {
        job.status = "cancelled"; log(`job ${id} cancelled by user`);
        const qi = queue.indexOf(id); if (qi >= 0) queue.splice(qi, 1);
        pump();
      }
      return res.end(JSON.stringify(job || {}));
    }
    if (req.method === "GET" && url.pathname === "/api/audit") return res.end(JSON.stringify(audit.slice(-100)));
    res.statusCode = 404; return res.end(JSON.stringify({ error: "not found" }));
  } catch (e) { res.statusCode = 400; return res.end(JSON.stringify({ error: String(e.message) })); }
});
server.listen(PORT, () => console.log(`MolaTube harness on http://localhost:${PORT} (workers=${MAX_WORKERS})`));
