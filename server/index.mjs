// MolaTube v0.2 control plane: durable state, job queue, child-process workers,
// per-agent lifecycle, SSE live updates. Zero dependencies, Node 24.
// Rules: user-initiated tasks only; no third-party account automation; no exam work.
// v0.1 /api/jobs + /api/audit shapes are kept compatible.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { initDirs, loadState, saveState, appendEvent, loadEvents, workspaceOf, jail } from "./store.mjs";

const PORT = Number(process.env.PORT || 3000);
const MAX_RUNNING = Number(process.env.MAX_RUNNING || 3);
const PER_USER_RUNNING = Number(process.env.PER_USER_RUNNING || 2);
const QUEUE_MAX = Number(process.env.QUEUE_MAX || 100);
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS || 120_000);
const WORKER_MEM_MB = Number(process.env.WORKER_MEM_MB || 256);

initDirs();
const state = loadState();
const children = new Map(); // jobId -> ChildProcess
const timers = new Map();   // jobId -> timeout handle
const sseClients = new Set();

// ---- boot resume: honest state, never pretend interrupted work finished ----
let resumed = 0;
for (const job of state.jobs) {
  if (job.status === "running") { job.status = "interrupted"; resumed++; }
}
for (const agent of state.agents) {
  if (agent.status === "working") agent.status = "waiting";
}
if (resumed) {
  appendEvent({ kind: "boot", note: `${resumed} interrupted job(s) marked on restart` });
  saveState(state);
}

const audit = loadEvents(500);
const log = (event) => {
  const line = appendEvent(event);
  audit.push(line);
  if (audit.length > 500) audit.shift();
  broadcast({ type: "event", line });
};
const broadcast = (obj) => {
  const data = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of [...sseClients]) {
    try { res.write(data); } catch { sseClients.delete(res); }
  }
};
const persist = () => saveState(state);
const findAgent = (id) => state.agents.find((a) => a.id === id);
const findJob = (id) => state.jobs.find((j) => j.id === id);
const agentCurrentJob = (agentId) => state.jobs.find((j) => j.agentId === agentId && (j.status === "queued" || j.status === "running"));
const runningCount = (user) => state.jobs.filter((j) => j.status === "running" && (!user || j.user === user)).length;

function setJob(job, patch, event) {
  Object.assign(job, patch);
  persist();
  if (event) log(event);
  broadcast({ type: "state", agents: state.agents, jobs: state.jobs });
  return job;
}
function setAgent(agent, patch, event) {
  Object.assign(agent, patch);
  persist();
  if (event) log(event);
  broadcast({ type: "state", agents: state.agents, jobs: state.jobs });
  return agent;
}

function pump() {
  if (runningCount() >= MAX_RUNNING) return;
  // FIFO scan with skip (not head-of-line blocking): a job held by a cap
  // does not stop later jobs that can run.
  for (const job of state.jobs.filter((j) => j.status === "queued")) {
    if (runningCount() >= MAX_RUNNING) break;
    if (runningCount(job.user) >= PER_USER_RUNNING) continue;
    if (job.agentId) {
      const agent = findAgent(job.agentId);
      if (!agent || agent.status === "paused" || agent.status === "stopped") continue;
      if (agentCurrentJob(job.agentId)?.status === "running") continue;
    }
    startJob(job);
  }
}

function startJob(job) {
  const dir = workspaceOf(job.id);
  fs.mkdirSync(dir, { recursive: true });
  setJob(job, { status: "running", startedAt: Date.now(), progress: job.progress || 0 }, { kind: "job_start", job: job.id, agent: job.agentId || null, type: job.type, video: job.videoId, user: job.user });
  if (job.agentId) {
    const agent = findAgent(job.agentId);
    if (agent && agent.status !== "stopped") setAgent(agent, { status: "working", currentJobId: job.id }, null);
  }
  const child = fork(path.resolve(import.meta.dirname, "worker.mjs"), [], {
    env: {
      PATH: process.env.PATH || "",
      MOLATUBE_JOB_ID: job.id,
      MOLATUBE_AGENT_ID: job.agentId || "",
      MOLATUBE_TYPE: job.type,
      MOLATUBE_VIDEO_ID: job.videoId,
      MOLATUBE_WORKSPACE: dir,
    },
    execArgv: [`--max-old-space-size=${WORKER_MEM_MB}`],
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  children.set(job.id, child);
  child.on("message", (msg) => {
    if (job.status !== "running") return;
    if (msg.kind === "progress") setJob(job, { progress: msg.progress, step: msg.step }, null);
    else if (msg.kind === "done") {
      clearTimer(job.id);
      setJob(job, { status: "done", progress: 100, result: msg.result }, { kind: "job_done", job: job.id, agent: job.agentId || null });
      finishAgent(job);
    } else if (msg.kind === "cancelled") {
      clearTimer(job.id);
      setJob(job, { status: "cancelled" }, { kind: "job_cancelled", job: job.id, agent: job.agentId || null });
      finishAgent(job);
    }
  });
  child.on("exit", (code) => {
    children.delete(job.id);
    clearTimer(job.id);
    if (job.status === "running") {
      // Worker died without reporting: honest failure, never silent success.
      setJob(job, { status: "failed", result: `Worker 异常退出（code ${code}），请重试。` }, { kind: "job_failed", job: job.id, agent: job.agentId || null, code });
      finishAgent(job);
    }
    pump();
  });
  const timer = setTimeout(() => {
    if (job.status === "running") {
      killChild(job.id);
      setJob(job, { status: "timeout", result: "任务超时，已强行终止。" }, { kind: "job_timeout", job: job.id, agent: job.agentId || null });
      finishAgent(job);
      pump();
    }
  }, JOB_TIMEOUT_MS);
  timers.set(job.id, timer);
}

function clearTimer(jobId) {
  const t = timers.get(jobId);
  if (t) { clearTimeout(t); timers.delete(jobId); }
}
function killChild(jobId) {
  const child = children.get(jobId);
  if (!child) return;
  try { child.kill("SIGTERM"); } catch { /* already gone */ }
  setTimeout(() => { try { if (!child.killed) child.kill("SIGKILL"); } catch { /* gone */ } }, 2000);
}
function finishAgent(job) {
  if (!job.agentId) return;
  const agent = findAgent(job.agentId);
  if (!agent) return;
  if (agent.status === "stopped") return;
  if (agent.pauseAfterCurrent) {
    setAgent(agent, { status: "paused", pauseAfterCurrent: false, currentJobId: null }, { kind: "agent_paused", agent: agent.id });
  } else if (job.status === "done") {
    setAgent(agent, { status: "idle", currentJobId: null }, null);
  } else {
    // failed / timeout / cancelled / interrupted -> waits for a person.
    setAgent(agent, { status: "waiting", currentJobId: null }, null);
  }
}
function cancelJob(job, reason) {
  if (job.status === "queued") {
    setJob(job, { status: "cancelled" }, { kind: "job_cancelled", job: job.id, agent: job.agentId || null, reason });
  } else if (job.status === "running") {
    killChild(job.id);
    setJob(job, { status: "cancelled" }, { kind: "job_cancelled", job: job.id, agent: job.agentId || null, reason });
  }
  if (job.agentId) {
    const agent = findAgent(job.agentId);
    if (agent && agent.status !== "stopped") setAgent(agent, { status: "idle", currentJobId: null }, null);
  }
  pump();
}

function body(req) {
  return new Promise((res) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => { try { res(JSON.parse(s || "{}")); } catch { res({}); } });
  });
}
const send = (res, obj, code = 200) => { res.statusCode = code; res.end(JSON.stringify(obj)); };
const TYPES = ["summary", "qa", "notes", "quiz"];

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-User");
  if (req.method === "OPTIONS") return res.end();
  const url = new URL(req.url, "http://localhost");
  const user = String(req.headers["x-user"] || "demo-user").slice(0, 64); // v0: demo user; wire real auth here.
  const mine = (list) => list.filter((x) => x.user === user);
  try {
    // ---- SSE live stream ----
    if (req.method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(`data: ${JSON.stringify({ type: "snapshot", agents: mine(state.agents), jobs: mine(state.jobs) })}\n\n`);
      sseClients.add(res);
      const hb = setInterval(() => { try { res.write(": heartbeat\n\n"); } catch { clearInterval(hb); sseClients.delete(res); } }, 15000);
      req.on("close", () => { clearInterval(hb); sseClients.delete(res); });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/health") {
      return send(res, { running: runningCount(), queued: state.jobs.filter((j) => j.status === "queued").length, agents: mine(state.agents).length, caps: { MAX_RUNNING, PER_USER_RUNNING, QUEUE_MAX, JOB_TIMEOUT_MS } });
    }
    // ---- agents ----
    if (req.method === "GET" && url.pathname === "/api/agents") return send(res, mine(state.agents).reverse());
    if (req.method === "POST" && url.pathname === "/api/agents") {
      const b = await body(req);
      const type = TYPES.includes(b.type) ? b.type : "summary";
      const agent = { id: randomUUID(), user, name: String(b.name || `Agent-${state.agents.length + 1}`).slice(0, 64), type, videoId: String(b.videoId || "v1").slice(0, 64), status: "idle", currentJobId: null, pauseAfterCurrent: false, notes: [], createdAt: Date.now() };
      state.agents.push(agent);
      setAgent(agent, {}, { kind: "agent_created", agent: agent.id, type, video: agent.videoId, user });
      return send(res, agent);
    }
    const agentMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/(start|pause|resume|stop|retry|note)$/);
    if (req.method === "POST" && agentMatch) {
      const [, id, action] = agentMatch;
      const agent = findAgent(id);
      if (!agent || agent.user !== user) return send(res, { error: "agent not found" }, 404);
      const b = action === "note" ? await body(req) : {};
      if (action === "start") {
        if (agent.status === "working") return send(res, agent);
        if (agentCurrentJob(id)) return send(res, agent);
        const queued = state.jobs.filter((j) => j.status === "queued").length;
        if (queued >= QUEUE_MAX) return send(res, { error: "队列已满，请稍后再试" }, 429);
        const dup = state.jobs.find((j) => j.agentId === id && j.type === agent.type && j.videoId === agent.videoId && (j.status === "queued" || j.status === "running"));
        if (dup) return send(res, agent);
        const job = { id: randomUUID(), agentId: id, user, videoId: agent.videoId, type: agent.type, status: "queued", progress: 0, step: "", result: "", workspace: `server/workspaces/${""}` };
        job.workspace = `server/workspaces/${job.id}`;
        state.jobs.push(job);
        setJob(job, {}, { kind: "job_queued", job: job.id, agent: id, type: job.type, video: job.videoId, user });
        pump();
        return send(res, agent);
      }
      if (action === "pause") {
        if (agent.status === "working") { setAgent(agent, { pauseAfterCurrent: true }, { kind: "agent_pause_after_current", agent: id }); }
        else if (agent.status === "idle") { setAgent(agent, { status: "paused" }, { kind: "agent_paused", agent: id }); }
        return send(res, agent);
      }
      if (action === "resume") {
        setAgent(agent, { status: "idle", pauseAfterCurrent: false }, { kind: "agent_resumed", agent: id });
        pump();
        return send(res, agent);
      }
      if (action === "stop") {
        for (const job of state.jobs.filter((j) => j.agentId === id && (j.status === "queued" || j.status === "running"))) cancelJob(job, "stopped by user");
        setAgent(agent, { status: "stopped", pauseAfterCurrent: false, currentJobId: null }, { kind: "agent_stopped", agent: id });
        return send(res, agent);
      }
      if (action === "retry") {
        const last = [...state.jobs].filter((j) => j.agentId === id).reverse()[0];
        if (!last || !["failed", "interrupted", "timeout", "cancelled"].includes(last.status)) return send(res, { error: "没有可重试的失败任务" }, 400);
        setAgent(agent, { status: "idle", pauseAfterCurrent: false }, null);
        const job = { id: randomUUID(), agentId: id, user, videoId: last.videoId, type: last.type, status: "queued", progress: 0, step: "", result: "", workspace: "" };
        job.workspace = `server/workspaces/${job.id}`;
        state.jobs.push(job);
        setJob(job, {}, { kind: "job_queued", job: job.id, agent: id, type: job.type, video: job.videoId, user, retryOf: last.id });
        pump();
        return send(res, agent);
      }
      if (action === "note") {
        const text = String(b.text || "").slice(0, 2000);
        if (!text) return send(res, { error: "备注为空" }, 400);
        agent.notes.push({ at: Date.now(), text });
        log({ kind: "agent_note", agent: id, user });
        const cur = agentCurrentJob(id);
        if (cur) { try { fs.writeFileSync(jail(cur.id, "notes.txt"), agent.notes.map((n) => n.text).join("\n")); } catch { /* workspace not started */ } }
        persist();
        broadcast({ type: "state", agents: state.agents, jobs: state.jobs });
        return send(res, agent);
      }
    }
    if (req.method === "GET" && /^\/api\/agents\/[^/]+$/.test(url.pathname)) {
      const agent = findAgent(url.pathname.split("/")[3]);
      if (!agent || agent.user !== user) return send(res, { error: "agent not found" }, 404);
      return send(res, { ...agent, jobs: state.jobs.filter((j) => j.agentId === agent.id).reverse() });
    }
    // ---- jobs (v0.1 compatible: one-shot jobs without an agent) ----
    if (req.method === "GET" && url.pathname === "/api/jobs") return send(res, mine(state.jobs).reverse());
    if (req.method === "POST" && url.pathname === "/api/jobs") {
      const b = await body(req);
      const type = TYPES.includes(b.type) ? b.type : "summary";
      const videoId = String(b.videoId || "v1").slice(0, 64);
      const dup = state.jobs.find((j) => !j.agentId && j.user === user && j.videoId === videoId && j.type === type && (j.status === "queued" || j.status === "running"));
      if (dup) return send(res, dup);
      if (state.jobs.filter((j) => j.status === "queued").length >= QUEUE_MAX) return send(res, { error: "队列已满，请稍后再试" }, 429);
      const job = { id: randomUUID(), agentId: null, user, videoId, type, status: "queued", progress: 0, step: "", result: "", workspace: "" };
      job.workspace = `server/workspaces/${job.id}`;
      state.jobs.push(job);
      setJob(job, {}, { kind: "job_queued", job: job.id, type, video: videoId, user });
      pump();
      return send(res, job);
    }
    if (req.method === "POST" && /^\/api\/jobs\/[^/]+\/cancel$/.test(url.pathname)) {
      const job = findJob(url.pathname.split("/")[3]);
      if (!job || job.user !== user) return send(res, { error: "job not found" }, 404);
      if (job.status === "queued" || job.status === "running") cancelJob(job, "cancelled by user");
      return send(res, job);
    }
    if (req.method === "GET" && url.pathname === "/api/audit") {
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify(audit.slice(-100)));
    }
    return send(res, { error: "not found" }, 404);
  } catch (e) {
    return send(res, { error: String(e.message) }, 400);
  }
});

server.listen(PORT, () => console.log(`MolaTube harness v0.2 on http://localhost:${PORT} (max_running=${MAX_RUNNING}, per_user=${PER_USER_RUNNING}, queue_max=${QUEUE_MAX})`));
