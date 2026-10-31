// MolaTube v1.0 control plane: durable state, channels, keys, quotas,
// job queue, child-process workers, per-agent lifecycle, SSE live updates,
// and static serving of the web/ frontend (open http://localhost:3000/).
// Zero dependencies, Node 24.
// Rules: user-initiated tasks only; no third-party account automation; no exam work.
// v0.1/v0.2 /api/jobs + /api/audit shapes are kept compatible.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { initDirs, loadState, saveState, appendEvent, loadEvents, workspaceOf } from "./store.mjs";
import { loadChannels, saveChannels, routeChannel, newChannel, CHANNEL_TYPES } from "./channels.mjs";
import { loadKeys, saveKeys, createKey, verifyKey, maskKey } from "./keys.mjs";
import { loadQuotas, saveQuotas, getQuota, jobsToday } from "./quotas.mjs";
import { computeStats } from "./stats.mjs";
import { loadPlugins, allPluginDirs, findPlugin } from "./plugins.mjs";

const PORT = Number(process.env.PORT || 3000);
const MAX_RUNNING = Number(process.env.MAX_RUNNING || 3);
const PER_USER_RUNNING = Number(process.env.PER_USER_RUNNING || 2);
const QUEUE_MAX = Number(process.env.QUEUE_MAX || 100);
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS || 120_000);
const WORKER_MEM_MB = Number(process.env.WORKER_MEM_MB || 256);
const REQUIRE_KEY = process.env.MOLATUBE_REQUIRE_KEY === "1";
const WEB_DIR = path.resolve(import.meta.dirname, "..", "web");

initDirs();
const state = loadState();
let channels = loadChannels();
let keys = loadKeys();
let quotas = loadQuotas();
let pluginRegistry = null;
async function ensurePlugins() {
  if (!pluginRegistry) pluginRegistry = await loadPlugins(allPluginDirs());
  return pluginRegistry;
}
const children = new Map();
const timers = new Map();
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

// ---- auth: API key wins; no key -> demo user (unless REQUIRE_KEY=1) ----
function resolveUser(req) {
  const plain = req.headers["x-api-key"];
  if (plain) {
    const rec = verifyKey(keys, plain);
    if (!rec) return { error: "invalid or exhausted API key" };
    rec.used += 1;
    saveKeys(keys);
    return { user: rec.owner, key: rec };
  }
  if (REQUIRE_KEY) return { error: "API key required" };
  return { user: String(req.headers["x-user"] || "demo-user").slice(0, 64) };
}

let draining = false;
function pump() {
  if (draining) return;
  if (runningCount() >= MAX_RUNNING) return;
  for (const job of state.jobs.filter((j) => j.status === "queued")) {
    if (runningCount() >= MAX_RUNNING) break;
    if (runningCount(job.user) >= PER_USER_RUNNING) continue;
    if (job.agentId) {
      const agent = findAgent(job.agentId);
      if (!agent || agent.status === "paused" || agent.status === "stopped") continue;
      if (agentCurrentJob(job.agentId)?.status === "running") continue;
    }
    const channel = job.channelId ? channels.find((c) => c.id === job.channelId) : routeChannel(channels);
    if (!channel || !channel.enabled) continue; // all channels off: stay queued, honestly.
    if (channel.concurrency > 0 && state.jobs.filter((j) => j.status === "running" && j.channel === channel.id).length >= channel.concurrency) continue;
    startJob(job, channel);
  }
}

// Spawn one executor for a job. Local forks worker.mjs directly; magpie
// forks magpie-runner.mjs, which schema-validates the tool-call envelope
// and then forks the same worker. Both report progress over IPC.
function spawnExecutor(job, channel) {
  const dir = workspaceOf(job.id);
  fs.mkdirSync(dir, { recursive: true });
  const baseEnv = {
    PATH: process.env.PATH || "",
    MOLATUBE_JOB_ID: job.id,
    MOLATUBE_AGENT_ID: job.agentId || "",
    MOLATUBE_TYPE: job.type,
    MOLATUBE_VIDEO_ID: job.videoId,
    MOLATUBE_WORKSPACE: dir,
    MOLATUBE_WORKER_MEM_MB: String(WORKER_MEM_MB),
    MOLATUBE_QUESTION: job.question || "",
    MOLATUBE_PLUGIN: job.plugin || "",
    MOLATUBE_TOOL: job.tool || "",
    MOLATUBE_ARGS_JSON: JSON.stringify(job.args || {}),
    MOLATUBE_PLUGIN_DIRS: allPluginDirs().join(":"),
    MOLATUBE_DATA_DIR: path.resolve(import.meta.dirname, "data"),
    MAGPIE_LAYERFS_HOME: process.env.MAGPIE_LAYERFS_HOME || path.resolve(import.meta.dirname, "data", "layerfs-home"),
    MAGPIE_LAYERFS_PAGE_DIR: process.env.MAGPIE_LAYERFS_PAGE_DIR || path.resolve(import.meta.dirname, "data", "layerfs-page"),
  };
  if (channel.type === "magpie") {
    return fork(path.resolve(import.meta.dirname, "magpie-runner.mjs"), [], {
      env: { ...baseEnv, MOLATUBE_TOOL_CALL: JSON.stringify({ tool: "molatube.run_job", arguments: { type: job.type, videoId: job.videoId, question: job.question, plugin: job.plugin, tool: job.tool, args: job.args } }) },
      execArgv: [`--max-old-space-size=${WORKER_MEM_MB}`],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
  }
  return fork(path.resolve(import.meta.dirname, "worker.mjs"), [], {
    env: baseEnv,
    execArgv: [`--max-old-space-size=${WORKER_MEM_MB}`],
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
}

function startJob(job, channel) {
  setJob(job, { status: "running", channel: channel.id, startedAt: Date.now(), progress: job.progress || 0 }, { kind: "job_start", job: job.id, agent: job.agentId || null, type: job.type, video: job.videoId, user: job.user, channel: channel.id });
  if (job.agentId) {
    const agent = findAgent(job.agentId);
    if (agent && agent.status !== "stopped") setAgent(agent, { status: "working", currentJobId: job.id }, null);
  }
  const child = spawnExecutor(job, channel);
  children.set(job.id, child);
  child.on("message", (msg) => {
    if (job.status !== "running") return;
    if (msg.kind === "progress") setJob(job, { progress: msg.progress, step: msg.step }, null);
    else if (msg.kind === "done") {
      clearTimer(job.id);
      setJob(job, { status: "done", progress: 100, result: msg.result }, { kind: "job_done", job: job.id, agent: job.agentId || null, channel: channel.id });
      finishAgent(job);
    } else if (msg.kind === "cancelled") {
      clearTimer(job.id);
      setJob(job, { status: "cancelled" }, { kind: "job_cancelled", job: job.id, agent: job.agentId || null });
      finishAgent(job);
    } else if (msg.kind === "error") {
      clearTimer(job.id);
      setJob(job, { status: "failed", result: `通道校验失败：${msg.error}` }, { kind: "job_failed", job: job.id, agent: job.agentId || null, channel: channel.id });
      finishAgent(job);
    }
  });
  child.on("exit", (code) => {
    children.delete(job.id);
    clearTimer(job.id);
    // Grace period: the child's exit event can arrive before its last IPC
    // message is delivered. A worker that finished its artifacts and sent
    // "done" must not be marked failed just because exit won the race.
    // Wait 200ms; if the job is still running then, it really produced
    // no result.
    setTimeout(() => {
      if (job.status === "running") {
        setJob(job, { status: "failed", result: `Worker 异常退出（code ${code}），请重试。` }, { kind: "job_failed", job: job.id, agent: job.agentId || null, code });
        finishAgent(job);
      }
      pump();
    }, 200);
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
  try { child.kill("SIGTERM"); } catch { /* gone */ }
  setTimeout(() => { try { if (!child.killed) child.kill("SIGKILL"); } catch { /* gone */ } }, 2000);
}
function finishAgent(job) {
  if (!job.agentId) return;
  const agent = findAgent(job.agentId);
  if (!agent || agent.status === "stopped") return;
  if (agent.pauseAfterCurrent) {
    setAgent(agent, { status: "paused", pauseAfterCurrent: false, currentJobId: null }, { kind: "agent_paused", agent: agent.id });
  } else if (job.status === "done") {
    setAgent(agent, { status: "idle", currentJobId: null }, null);
  } else {
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
function quotaCheck(user, kind) {
  const q = getQuota(quotas, user);
  if (kind === "agent" && state.agents.filter((a) => a.user === user && a.status !== "stopped").length >= q.maxAgents) {
    return `Agent 数量已达上限（${q.maxAgents}），请先停止或删除旧 agent`;
  }
  if (kind === "job" && q.maxJobsPerDay > 0 && jobsToday(state.jobs, user) >= q.maxJobsPerDay) {
    return `今日任务数已达上限（${q.maxJobsPerDay}）`;
  }
  return null;
}
function newJob({ agentId, user, videoId, type, channelId, question, plugin, tool, args }) {
  const job = { id: randomUUID(), agentId: agentId || null, user, videoId, type, status: "queued", progress: 0, step: "", result: "", workspace: "", channel: null, channelId: channelId || null, question: question || "", plugin: plugin || "", tool: tool || "", args: args || {}, createdAt: Date.now() };
  job.workspace = `server/workspaces/${job.id}`;
  return job;
}

function body(req) {
  return new Promise((res) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => { try { res(JSON.parse(s || "{}")); } catch { res({}); } });
  });
}
const send = (res, obj, code = 200) => { res.setHeader("Content-Type", "application/json"); res.statusCode = code; res.end(JSON.stringify(obj)); };
const TYPES = ["summary", "qa", "notes", "quiz", "plugin"];
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".webp": "image/webp", ".svg": "image/svg+xml", ".png": "image/png" };

function serveStatic(req, res, pathname) {
  let rel = pathname === "/" ? "/index.html" : pathname.replace(/^\/web\//, "/");
  if (rel.includes("..")) { res.statusCode = 400; return res.end("bad path"); }
  const file = path.join(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR)) { res.statusCode = 400; return res.end("bad path"); }
  try {
    const data = fs.readFileSync(file);
    res.setHeader("Content-Type", MIME[path.extname(file)] || "application/octet-stream");
    res.end(data);
  } catch {
    res.statusCode = 404;
    res.end("not found");
  }
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-User, X-Api-Key");
  if (req.method === "OPTIONS") return res.end();
  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname;
  if (!pathname.startsWith("/api/")) return serveStatic(req, res, pathname);
  const auth = resolveUser(req);
  if (auth.error) return send(res, { error: auth.error }, 401);
  const user = auth.user;
  const mine = (list) => list.filter((x) => x.user === user);
  try {
    if (req.method === "GET" && pathname === "/api/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(`data: ${JSON.stringify({ type: "snapshot", agents: mine(state.agents), jobs: mine(state.jobs) })}\n\n`);
      sseClients.add(res);
      const hb = setInterval(() => { try { res.write(": heartbeat\n\n"); } catch { clearInterval(hb); sseClients.delete(res); } }, 15000);
      req.on("close", () => { clearInterval(hb); sseClients.delete(res); });
      return;
    }
    if (req.method === "GET" && pathname === "/api/health") {
      return send(res, { running: runningCount(), queued: state.jobs.filter((j) => j.status === "queued").length, agents: mine(state.agents).length, channels: channels.length, caps: { MAX_RUNNING, PER_USER_RUNNING, QUEUE_MAX, JOB_TIMEOUT_MS } });
    }
    if (req.method === "GET" && pathname === "/api/stats") return send(res, computeStats({ agents: mine(state.agents), jobs: mine(state.jobs) }));
    // ---- channels ----
    if (req.method === "GET" && pathname === "/api/channels") return send(res, channels);
    if (req.method === "POST" && pathname === "/api/channels") {
      const b = await body(req);
      try {
        const ch = newChannel(b);
        channels.push(ch);
        saveChannels(channels);
        log({ kind: "channel_created", channel: ch.id, type: ch.type, user });
        return send(res, ch);
      } catch (e) { return send(res, { error: e.message }, 400); }
    }
    const chMatch = pathname.match(/^\/api\/channels\/([^/]+)(\/test)?$/);
    if (chMatch && (req.method === "PATCH" || req.method === "DELETE" || (req.method === "POST" && chMatch[2]))) {
      const ch = channels.find((c) => c.id === chMatch[1]);
      if (!ch) return send(res, { error: "channel not found" }, 404);
      if (req.method === "PATCH") {
        const b = await body(req);
        if (typeof b.enabled === "boolean") ch.enabled = b.enabled;
        if (Number.isFinite(Number(b.priority))) ch.priority = Number(b.priority);
        if (Number.isFinite(Number(b.weight))) ch.weight = Number(b.weight);
        if (Number.isFinite(Number(b.concurrency))) ch.concurrency = Math.max(0, Number(b.concurrency));
        if (typeof b.endpoint === "string") ch.endpoint = b.endpoint.slice(0, 512) || null;
        if (typeof b.name === "string" && b.name) ch.name = b.name.slice(0, 64);
        saveChannels(channels);
        log({ kind: "channel_updated", channel: ch.id, user });
        pump();
        return send(res, ch);
      }
      if (req.method === "DELETE") {
        if (ch.builtin) return send(res, { error: "内置通道只能停用，不能删除" }, 400);
        channels = channels.filter((c) => c.id !== ch.id);
        saveChannels(channels);
        return send(res, { deleted: ch.id });
      }
      // test: local -> worker file exists; magpie -> runner file exists (+ endpoint recorded, not probed as live)
      const ok = ch.type === "local"
        ? fs.existsSync(path.resolve(import.meta.dirname, "worker.mjs"))
        : fs.existsSync(path.resolve(import.meta.dirname, "magpie-runner.mjs"));
      return send(res, { ok, channel: ch.id, type: ch.type, endpoint: ch.endpoint || null, note: ch.endpoint ? "远端 endpoint 仅作配置记录，v1.0 仍走本地 runner" : "本地模式" });
    }
    // ---- keys ----
    if (req.method === "GET" && pathname === "/api/keys") return send(res, keys.filter((k) => k.owner === user).map(maskKey));
    if (req.method === "POST" && pathname === "/api/keys") {
      const b = await body(req);
      const { record, plain } = createKey({ name: b.name, owner: user, quota: b.quota, expiresAt: b.expiresAt });
      keys.push(record);
      saveKeys(keys);
      log({ kind: "key_created", key: record.id, user });
      return send(res, { ...maskKey(record), plain });
    }
    const keyMatch = pathname.match(/^\/api\/keys\/([^/]+)\/revoke$/);
    if (req.method === "POST" && keyMatch) {
      const k = keys.find((x) => x.id === keyMatch[1] && x.owner === user);
      if (!k) return send(res, { error: "key not found" }, 404);
      k.enabled = false;
      saveKeys(keys);
      return send(res, maskKey(k));
    }
    // ---- quotas ----
    if (req.method === "GET" && pathname === "/api/quotas") return send(res, getQuota(quotas, user));
    if (req.method === "PATCH" && pathname === "/api/quotas") {
      const b = await body(req);
      const cur = getQuota(quotas, user);
      if (Number.isFinite(Number(b.maxAgents))) cur.maxAgents = Number(b.maxAgents);
      if (Number.isFinite(Number(b.maxJobsPerDay))) cur.maxJobsPerDay = Number(b.maxJobsPerDay);
      quotas[user] = cur;
      saveQuotas(quotas);
      return send(res, cur);
    }
    // ---- plugins ----
    if (req.method === "GET" && pathname === "/api/plugins") {
      pluginRegistry = await loadPlugins(allPluginDirs());
      return send(res, pluginRegistry.map((p) => ({ name: p.name, error: p.error || null, tools: Object.entries(p.tools).map(([name, t]) => ({ name, description: t.description || "" })) })));
    }
    const pluginCallMatch = pathname.match(/^\/api\/plugins\/([^/]+)\/([^/]+)\/call$/);
    if (req.method === "POST" && pluginCallMatch) {
      const [, pluginName, toolName] = pluginCallMatch;
      const plugins = await ensurePlugins();
      const plugin = findPlugin(plugins, pluginName);
      if (!plugin || plugin.error) return send(res, { error: plugin?.error || "plugin not found" }, 404);
      const tool = plugin.tools[toolName];
      if (!tool) return send(res, { error: "tool not found" }, 404);
      const b = await body(req);
      const callDir = path.resolve(import.meta.dirname, "data", "plugin-calls", randomUUID());
      fs.mkdirSync(callDir, { recursive: true });
      const child = fork(path.resolve(import.meta.dirname, "plugin-runner.mjs"), [], {
        env: { PATH: process.env.PATH || "", PLUGIN_DIR: plugin.dir, TOOL_NAME: toolName, ARGS_JSON: JSON.stringify(b.args || {}), WORKSPACE: callDir, AGENT: user, MOLATUBE_DATA_DIR: path.resolve(import.meta.dirname, "data"), MAGPIE_LAYERFS_HOME: process.env.MAGPIE_LAYERFS_HOME || path.resolve(import.meta.dirname, "data", "layerfs-home"), MAGPIE_LAYERFS_PAGE_DIR: process.env.MAGPIE_LAYERFS_PAGE_DIR || path.resolve(import.meta.dirname, "data", "layerfs-page") },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      let answered = false;
      const timer = setTimeout(() => {
        if (answered) return;
        answered = true;
        try { child.kill("SIGKILL"); } catch { /* gone */ }
        send(res, { error: "plugin call timed out (30s)" }, 504);
      }, 30000);
      child.on("message", (msg) => {
        if (answered) return;
        answered = true;
        clearTimeout(timer);
        if (msg.kind === "done") send(res, { result: msg.result, workspace: callDir });
        else send(res, { error: msg.error || "plugin call failed" }, 400);
      });
      child.on("exit", (code) => {
        if (answered) return;
        // Same exit-before-message race: wait 200ms for a result message.
        setTimeout(() => {
          if (answered) return;
          answered = true;
          clearTimeout(timer);
          send(res, { error: `plugin runner exited (code ${code})` }, 400);
        }, 200);
      });
      return;
    }
    // ---- agents ----
    if (req.method === "GET" && pathname === "/api/agents") return send(res, mine(state.agents).reverse());
    if (req.method === "POST" && pathname === "/api/agents") {
      const err = quotaCheck(user, "agent");
      if (err) return send(res, { error: err }, 429);
      const b = await body(req);
      const type = TYPES.includes(b.type) ? b.type : "summary";
      let plugin = "", tool = "", args = {};
      if (type === "plugin") {
        const plugins = await ensurePlugins();
        const p = findPlugin(plugins, b.plugin || "");
        if (!p || p.error || !p.tools[b.tool || ""]) return send(res, { error: "plugin or tool not found" }, 400);
        plugin = b.plugin; tool = b.tool; args = (b.args && typeof b.args === "object") ? b.args : {};
      }
      const agent = { id: randomUUID(), user, name: String(b.name || `Agent-${state.agents.length + 1}`).slice(0, 64), type, videoId: String(b.videoId || "v1").slice(0, 64), plugin, tool, args, status: "idle", currentJobId: null, pauseAfterCurrent: false, notes: [], createdAt: Date.now() };
      state.agents.push(agent);
      setAgent(agent, {}, { kind: "agent_created", agent: agent.id, type, video: agent.videoId, user });
      return send(res, agent);
    }
    const agentMatch = pathname.match(/^\/api\/agents\/([^/]+)\/(start|pause|resume|stop|retry|note)$/);
    if (req.method === "POST" && agentMatch) {
      const [, id, action] = agentMatch;
      const agent = findAgent(id);
      if (!agent || agent.user !== user) return send(res, { error: "agent not found" }, 404);
      const b = action === "note" ? await body(req) : {};
      if (action === "start") {
        if (agent.status === "working" || agentCurrentJob(id)) return send(res, agent);
        const err = quotaCheck(user, "job");
        if (err) return send(res, { error: err }, 429);
        if (state.jobs.filter((j) => j.status === "queued").length >= QUEUE_MAX) return send(res, { error: "队列已满，请稍后再试" }, 429);
        const question = agent.type === "qa" && agent.notes.length ? agent.notes[agent.notes.length - 1].text : "";
        const job = newJob({ agentId: id, user, videoId: agent.videoId, type: agent.type, question, plugin: agent.plugin, tool: agent.tool, args: agent.args });
        state.jobs.push(job);
        setJob(job, {}, { kind: "job_queued", job: job.id, agent: id, type: job.type, video: job.videoId, user });
        pump();
        return send(res, agent);
      }
      if (action === "pause") {
        if (agent.status === "working") setAgent(agent, { pauseAfterCurrent: true }, { kind: "agent_pause_after_current", agent: id });
        else if (agent.status === "idle") setAgent(agent, { status: "paused" }, { kind: "agent_paused", agent: id });
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
        const err = quotaCheck(user, "job");
        if (err) return send(res, { error: err }, 429);
        setAgent(agent, { status: "idle", pauseAfterCurrent: false }, null);
        const job = newJob({ agentId: id, user, videoId: last.videoId, type: last.type, question: last.question, plugin: last.plugin, tool: last.tool, args: last.args });
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
        if (cur) {
          try {
            const ws = workspaceOf(cur.id);
            fs.writeFileSync(path.join(ws, "notes.txt"), agent.notes.map((n) => n.text).join("\n"));
          } catch { /* workspace not started */ }
        }
        persist();
        broadcast({ type: "state", agents: state.agents, jobs: state.jobs });
        return send(res, agent);
      }
    }
    if (req.method === "GET" && /^\/api\/agents\/[^/]+$/.test(pathname)) {
      const agent = findAgent(pathname.split("/")[3]);
      if (!agent || agent.user !== user) return send(res, { error: "agent not found" }, 404);
      return send(res, { ...agent, jobs: state.jobs.filter((j) => j.agentId === agent.id).reverse() });
    }
    // ---- jobs (v0.1 compatible) ----
    if (req.method === "GET" && pathname === "/api/jobs") return send(res, mine(state.jobs).reverse());
    if (req.method === "POST" && pathname === "/api/jobs") {
      const b = await body(req);
      const type = TYPES.includes(b.type) ? b.type : "summary";
      const videoId = String(b.videoId || "v1").slice(0, 64);
      const dup = state.jobs.find((j) => !j.agentId && j.user === user && j.videoId === videoId && j.type === type && (j.status === "queued" || j.status === "running"));
      if (dup) return send(res, dup);
      const err = quotaCheck(user, "job");
      if (err) return send(res, { error: err }, 429);
      if (state.jobs.filter((j) => j.status === "queued").length >= QUEUE_MAX) return send(res, { error: "队列已满，请稍后再试" }, 429);
      let channelId = null;
      if (b.channelId) {
        const ch = channels.find((c) => c.id === b.channelId);
        if (!ch) return send(res, { error: "channel not found" }, 400);
        if (!ch.enabled) return send(res, { error: "所选通道已停用" }, 400);
        channelId = ch.id;
      }
      let plugin = "", tool = "", args = {};
      if (type === "plugin") {
        const plugins = await ensurePlugins();
        const p = findPlugin(plugins, b.plugin || "");
        if (!p || p.error || !p.tools[b.tool || ""]) return send(res, { error: "plugin or tool not found" }, 400);
        plugin = b.plugin; tool = b.tool; args = (b.args && typeof b.args === "object") ? b.args : {};
      }
      const job = newJob({ user, videoId, type, channelId, question: String(b.question || "").slice(0, 2000), plugin, tool, args });
      state.jobs.push(job);
      setJob(job, {}, { kind: "job_queued", job: job.id, type, video: videoId, user });
      pump();
      return send(res, job);
    }
    if (req.method === "POST" && /^\/api\/jobs\/[^/]+\/cancel$/.test(pathname)) {
      const job = findJob(pathname.split("/")[3]);
      if (!job || job.user !== user) return send(res, { error: "job not found" }, 404);
      if (job.status === "queued" || job.status === "running") cancelJob(job, "cancelled by user");
      return send(res, job);
    }
    if (req.method === "GET" && pathname === "/api/audit") return send(res, audit.slice(-100));
    return send(res, { error: "not found" }, 404);
  } catch (e) {
    return send(res, { error: String(e.message) }, 400);
  }
});

// Graceful shutdown: stop starting new jobs, wait up to 10s for running
// jobs to finish, then kill the rest, save state and exit. A killed job
// is marked interrupted on the next boot, never silently dropped.
async function shutdown(signal) {
  if (draining) return;
  draining = true;
  console.log(`MolaTube shutting down (${signal}), draining...`);
  server.close();
  const deadline = Date.now() + 10000;
  while (runningCount() > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
  for (const [jobId] of children) killChild(jobId);
  saveState(state);
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

server.listen(PORT, () => console.log(`MolaTube v1.1 on http://localhost:${PORT} (max_running=${MAX_RUNNING}, per_user=${PER_USER_RUNNING}, queue_max=${QUEUE_MAX}, require_key=${REQUIRE_KEY})`));
