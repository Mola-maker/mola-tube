// Real browser daemon (v1.2 final stack): one Node process owning a pool of
// headless Chromium browsers, driven over raw CDP through
// --remote-debugging-pipe (fd3 in / fd4 out, NUL-delimited JSON), zero npm
// dependencies. Pipe replaces the earlier WebSocket transport: no TCP
// loopback, no port discovery, no exposed debugging port, and the browser
// lifetime is bound to this parent process.
// Pooling: browsers are created lazily up to BROWSER_POOL_SIZE (default 1;
// 1 browser is right for small servers — extra browsers only split the
// failure domain, they do not make one machine faster). A watchdog samples
// each browser's process-tree RSS and recycles browsers that are old,
// have served many contexts, or grow past the RSS cap — but only when
// they hold no open tabs.
// Isolation: every (user, agent) gets its own Target.createBrowserContext
// inside one browser; the default context is never handed to an agent.
// Safety: only public http(s) URLs. Private/loopback/link-local targets
// (including localhost and DNS that resolves to a private address) are
// refused — an agent must never use this browser to probe internal services.
// Tabs are owned by (user, agent); a caller only sees and touches its own.
// Screenshots default to viewport JPEG q75 (never full-page PNG): the
// image itself, not the transport, dominates screenshot cost.
import { spawn } from "node:child_process";
import { X509Certificate, createHash } from "node:crypto";
import dns from "node:dns";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const PORT = Number(process.env.BROWSER_PORT || 0);
const TOKEN = process.env.BROWSER_TOKEN || "";
const DATA_DIR = process.env.BROWSER_DATA_DIR || path.resolve(import.meta.dirname, "data");
const MAX_TABS = Number(process.env.BROWSER_MAX_TABS || 8);
const MAX_TABS_PER_AGENT = Number(process.env.BROWSER_MAX_TABS_PER_AGENT || 3);
const POOL_SIZE = Math.max(1, Number(process.env.BROWSER_POOL_SIZE || 1));
const TABS_PER_BROWSER = Number(process.env.BROWSER_TABS_PER_BROWSER || 20);
const NAV_TIMEOUT_MS = 20000;
const MAX_FRAME_BYTES = 32 * 1024 * 1024;
const RECYCLE_MINUTES = Number(process.env.BROWSER_RECYCLE_MINUTES || 60);
const RECYCLE_CONTEXTS = Number(process.env.BROWSER_RECYCLE_CONTEXTS || 200);
const MAX_RSS_MB = Number(process.env.BROWSER_MAX_RSS_MB || 2048);
const VIEWPORT_W = Number(process.env.BROWSER_VIEWPORT_W || 1280);
const VIEWPORT_H = Number(process.env.BROWSER_VIEWPORT_H || 800);
const WATCHDOG_MS = 20000;

function findChrome() {
  const candidates = [];
  if (process.env.CHROME_BIN) candidates.push(process.env.CHROME_BIN);
  try {
    const base = path.join(os.homedir(), ".cache", "ms-playwright");
    for (const d of fs.readdirSync(base)) {
      if (d.startsWith("chromium_headless_shell")) {
        candidates.push(path.join(base, d, "chrome-headless-shell-linux64", "chrome-headless-shell"));
      }
    }
  } catch { /* no playwright browsers */ }
  candidates.push("/opt/meta-chromium/chrome");
  for (const name of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
    for (const dir of (process.env.PATH || "").split(":")) candidates.push(path.join(dir, name));
  }
  for (const c of candidates) {
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch { /* next */ }
  }
  return null;
}

function isPrivateIp(ip) {
  if (net.isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      a === 127 || (a === 169 && b === 254) || a === 0 || a >= 224;
  }
  if (net.isIP(ip) === 6) {
    const l = ip.toLowerCase();
    return l === "::1" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe8") || l.startsWith("fe9") || l.startsWith("fea") || l.startsWith("feb");
  }
  return false;
}
const dnsCache = new Map();
async function assertPublicUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error("invalid URL"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("only http(s) URLs are allowed");
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) throw new Error("localhost/private hosts are refused");
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error("private IP targets are refused");
    return u.href;
  }
  const now = Date.now();
  let addrs = dnsCache.get(host);
  if (!addrs || addrs.at + 60000 < now) {
    const res = await dns.promises.lookup(host, { all: true });
    addrs = { at: now, list: res.map((r) => r.address) };
    dnsCache.set(host, addrs);
  }
  if (!addrs.list.length || addrs.list.some(isPrivateIp)) throw new Error("host resolves to a private address");
  return u.href;
}

// ---- CDP over pipe: parent writes JSON + NUL to the child's fd3,
// reads NUL-delimited JSON frames from the child's fd4. ----
class PipeCDP {
  constructor(writeStream, readStream) {
    this.nextId = 1;
    this.pending = new Map();
    this.loadWaiters = new Map();
    this.enabled = new Set();
    this.writeStream = writeStream;
    this.buffer = Buffer.alloc(0);
    this.dead = false;
    readStream.on("data", (chunk) => this.onData(chunk));
    readStream.on("error", () => this.failAll(new Error("CDP pipe closed")));
    readStream.on("close", () => this.failAll(new Error("CDP pipe closed")));
  }
  failAll(err) {
    if (this.dead) return;
    this.dead = true;
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
    for (const w of this.loadWaiters.values()) { clearTimeout(w.timer); w.reject(err); }
    this.loadWaiters.clear();
  }
  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_FRAME_BYTES) {
      // One frame must never be allowed to eat the daemon's memory.
      this.failAll(new Error("CDP frame over size limit"));
      return;
    }
    let idx;
    while ((idx = this.buffer.indexOf(0)) >= 0) {
      const frame = this.buffer.subarray(0, idx);
      this.buffer = this.buffer.subarray(idx + 1);
      if (!frame.length) continue;
      let msg;
      try { msg = JSON.parse(frame.toString("utf8")); } catch { continue; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || "CDP error"));
        else resolve(msg.result);
      } else if (msg.method === "Page.loadEventFired" && msg.sessionId && this.loadWaiters.has(msg.sessionId)) {
        const w = this.loadWaiters.get(msg.sessionId);
        this.loadWaiters.delete(msg.sessionId);
        clearTimeout(w.timer);
        w.resolve();
      }
    }
  }
  send(method, params = {}, sessionId) {
    if (this.dead) return Promise.reject(new Error("CDP pipe closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const ok = this.writeStream.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
      if (!ok) this.writeStream.once("drain", () => {});
    });
  }
  async attach(targetId) {
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    return sessionId;
  }
  async ensurePage(sessionId) {
    if (this.enabled.has(sessionId)) return;
    await this.send("Page.enable", {}, sessionId);
    await this.send("Runtime.enable", {}, sessionId);
    await this.send("Emulation.setDeviceMetricsOverride", { width: VIEWPORT_W, height: VIEWPORT_H, deviceScaleFactor: 1, mobile: false }, sessionId);
    this.enabled.add(sessionId);
  }
  waitLoad(sessionId) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.loadWaiters.delete(sessionId);
        reject(new Error("navigation timeout"));
      }, NAV_TIMEOUT_MS);
      this.loadWaiters.set(sessionId, { resolve: () => { clearTimeout(timer); resolve(); }, timer, reject });
    });
  }
  async navigate(sessionId, url) {
    await this.ensurePage(sessionId);
    const load = this.waitLoad(sessionId);
    await this.send("Page.navigate", { url }, sessionId);
    await load;
  }
  async read(sessionId) {
    await this.ensurePage(sessionId);
    const { result } = await this.send("Runtime.evaluate", {
      expression: "({title: document.title, url: location.href, text: (document.body ? document.body.innerText : '').slice(0, 4000)})",
      returnByValue: true,
    }, sessionId);
    return result.value;
  }
  async screenshot(sessionId) {
    await this.ensurePage(sessionId);
    const { data } = await this.send("Page.captureScreenshot", { format: "jpeg", quality: 75, captureBeyondViewport: false }, sessionId);
    return data;
  }
}

const chromeBin = findChrome();
if (!chromeBin) { console.error("browser-daemon: no Chrome binary found"); process.exit(2); }

// ---- localhost-only egress relay (sandbox MITM proxy auth) ----
async function startLocalRelay() {
  const raw = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY || "";
  if (!raw) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  const auth = u.username ? `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString("base64")}` : "";
  const relay = http.createServer();
  relay.on("connect", (req, clientSocket) => {
    const target = net.connect(Number(u.port || 3128), u.hostname, () => {
      const headers = [`CONNECT ${req.url} HTTP/1.1`, `Host: ${req.url}`, ...(auth ? [`Proxy-Authorization: ${auth}`] : []), "", ""].join("\r\n");
      target.write(headers);
    });
    target.once("data", (chunk) => {
      const text = chunk.toString();
      const sep = text.indexOf("\r\n\r\n");
      if (/^HTTP\/1\.[01] 200/.test(text)) {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (sep >= 0 && chunk.length > sep + 4) clientSocket.write(chunk.subarray(sep + 4));
        target.pipe(clientSocket);
        clientSocket.pipe(target);
      } else {
        clientSocket.end();
        target.end();
      }
    });
    target.on("error", () => clientSocket.end());
    clientSocket.on("error", () => target.end());
  });
  relay.on("request", (req, res) => {
    let targetUrl;
    try { targetUrl = new URL(req.url); } catch { res.writeHead(400); res.end(); return; }
    const sock = req.socket;
    const target = net.connect(Number(u.port || 3128), u.hostname, () => {
      const headers = [`${req.method} ${req.url} HTTP/1.1`, `Host: ${targetUrl.host}`, ...(auth ? [`Proxy-Authorization: ${auth}`] : []), "Connection: close", "", ""].join("\r\n");
      target.write(headers);
      req.pipe(target);
    });
    target.on("data", (chunk) => { try { sock.write(chunk); } catch { /* closed */ } });
    target.on("end", () => { try { sock.end(); } catch { /* closed */ } });
    target.on("error", () => { try { sock.end(); } catch { /* closed */ } });
  });
  const port = await new Promise((resolve) => relay.listen(0, "127.0.0.1", () => resolve(relay.address().port)));
  return { port, server: relay };
}
const relay = await startLocalRelay();

function chromeFlagsFor(profileDir) {
  const flags = [
    "--remote-debugging-pipe",
    `--user-data-dir=${profileDir}`,
    "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--disable-extensions", "--no-first-run", "--disable-default-apps",
    "--disable-background-networking", "--disable-sync", "--hide-scrollbars",
  ];
  if (!chromeBin.includes("headless")) flags.push("--headless=new");
  if (relay) flags.push(`--proxy-server=http://127.0.0.1:${relay.port}`);
  const bypass = process.env.no_proxy || process.env.NO_PROXY || "";
  if (bypass) flags.push(`--proxy-bypass-list=${bypass}`);
  // MITM egress proxies (this sandbox) re-sign TLS with a local CA. Trust
  // exactly that CA — and only that CA — via its SPKI pin, computed from
  // the CA file at boot. On a normal machine the file does not exist and
  // TLS verification is untouched (never a blanket ignore-cert-errors).
  const caPath = process.env.MOLATUBE_EGRESS_CA || "/usr/local/share/ca-certificates/hatch-egress-ca.crt";
  try {
    const pem = fs.readFileSync(caPath);
    const cert = new X509Certificate(pem);
    const pin = createHash("sha256").update(cert.publicKey.export({ type: "spki", format: "der" })).digest("base64");
    flags.push(`--ignore-certificate-errors-spki-list=${pin}`);
  } catch { /* no MITM CA here: normal TLS */ }
  return flags;
}

// ---- browser pool ----
const events = [];
function noteEvent(text) {
  events.push(`${new Date().toISOString()} ${text}`);
  if (events.length > 20) events.shift();
}
let nextBrowserId = 0;
const browsers = []; // {id, chrome, cdp, profileDir, contexts: Map, tabs: Set, createdAt, servedContexts, rssMb}
const tabs = new Map(); // external tabId -> {tabId, user, agent, browser, targetId, sessionId, url, title, createdAt}

function readRssTree(rootPid) {
  try {
    const children = new Map(); // pid -> {ppid, rss}
    for (const name of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const status = fs.readFileSync(`/proc/${name}/status`, "utf8");
        const ppid = Number(/PPid:\s+(\d+)/.exec(status)?.[1] || 0);
        const rss = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] || 0);
        children.set(Number(name), { ppid, rss });
      } catch { /* exited */ }
    }
    const byParent = new Map();
    for (const [pid, v] of children) {
      if (!byParent.has(v.ppid)) byParent.set(v.ppid, []);
      byParent.get(v.ppid).push(pid);
    }
    let total = 0;
    const queue = [rootPid];
    const seen = new Set();
    while (queue.length) {
      const pid = queue.shift();
      if (seen.has(pid)) continue;
      seen.add(pid);
      total += children.get(pid)?.rss || 0;
      for (const c of byParent.get(pid) || []) queue.push(c);
    }
    return Math.round(total / 1024);
  } catch { return null; }
}

async function spawnBrowser() {
  const id = nextBrowserId++;
  const profileDir = path.join(DATA_DIR, `browser-profile-${process.pid}-${id}`);
  fs.mkdirSync(profileDir, { recursive: true });
  const chrome = spawn(chromeBin, [...chromeFlagsFor(profileDir), "about:blank"], {
    stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
  });
  chrome.stdout?.on("data", () => {});
  chrome.stderr?.on("data", () => {});
  const b = { id, chrome, cdp: null, profileDir, contexts: new Map(), tabs: new Set(), createdAt: Date.now(), servedContexts: 0, rssMb: null, dead: false, readyPromise: null };
  const cdp = new PipeCDP(chrome.stdio[3], chrome.stdio[4]);
  b.cdp = cdp;
  chrome.on("exit", () => {
    b.dead = true;
    cdp.failAll(new Error("browser exited"));
    // Tabs on a dead browser are gone; drop them so callers get a clean
    // "tab not found" instead of a hung command.
    for (const tabId of [...b.tabs]) tabs.delete(tabId);
    b.tabs.clear();
    noteEvent(`browser b${id} exited`);
  });
  // Register in the pool BEFORE readiness resolves: concurrent tab opens
  // must share the starting browser instead of each spawning their own.
  browsers.push(b);
  b.readyPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("browser did not answer CDP")), 15000);
    chrome.once("exit", () => { clearTimeout(timer); reject(new Error("browser exited during startup")); });
    cdp.send("Browser.getVersion").then(() => { clearTimeout(timer); resolve(); }).catch((e) => { clearTimeout(timer); reject(e); });
  });
  try {
    await b.readyPromise;
  } catch (e) {
    const idx = browsers.indexOf(b);
    if (idx >= 0) browsers.splice(idx, 1);
    throw e;
  }
  noteEvent(`browser b${id} up`);
  return b;
}
async function acquireBrowser() {
  let best = null;
  for (const b of browsers) {
    if (b.dead) continue;
    if (!best || b.tabs.size < best.tabs.size) best = b;
  }
  if (best && best.tabs.size < TABS_PER_BROWSER) return best;
  if (browsers.filter((b) => !b.dead).length < POOL_SIZE) return spawnBrowser();
  if (best) return best;
  return spawnBrowser();
}
function killBrowser(b) {
  try { b.chrome.kill("SIGTERM"); } catch { /* gone */ }
  setTimeout(() => { try { b.chrome.kill("SIGKILL"); } catch { /* gone */ } }, 3000);
  try { fs.rmSync(b.profileDir, { recursive: true, force: true }); } catch { /* keep */ }
}
async function recycleBrowser(b, reason) {
  const idx = browsers.indexOf(b);
  if (idx >= 0) browsers.splice(idx, 1);
  for (const tabId of [...b.tabs]) tabs.delete(tabId);
  b.tabs.clear();
  killBrowser(b);
  noteEvent(`browser b${b.id} recycled (${reason})`);
}
async function watchdog() {
  for (const b of [...browsers]) {
    if (b.dead) {
      const idx = browsers.indexOf(b);
      if (idx >= 0) browsers.splice(idx, 1);
      continue;
    }
    b.rssMb = readRssTree(b.chrome.pid);
    if (b.tabs.size > 0) continue; // never kill a browser holding open tabs
    const ageMin = (Date.now() - b.createdAt) / 60000;
    if (b.rssMb !== null && b.rssMb > MAX_RSS_MB) await recycleBrowser(b, `rss ${b.rssMb}MB > ${MAX_RSS_MB}MB`);
    else if (ageMin > RECYCLE_MINUTES) await recycleBrowser(b, `age ${Math.round(ageMin)}min`);
    else if (b.servedContexts >= RECYCLE_CONTEXTS) await recycleBrowser(b, `${b.servedContexts} contexts served`);
  }
}
setInterval(() => { watchdog().catch(() => {}); }, WATCHDOG_MS);

async function ensureContext(browser, user, agent) {
  const key = `${user}/${agent}`;
  if (browser.contexts.has(key)) return browser.contexts.get(key);
  const { browserContextId } = await browser.cdp.send("Target.createBrowserContext");
  browser.contexts.set(key, browserContextId);
  browser.servedContexts += 1;
  return browserContextId;
}
function findContextBrowser(user, agent) {
  const key = `${user}/${agent}`;
  for (const b of browsers) {
    if (!b.dead && b.contexts.has(key)) return { browser: b, contextId: b.contexts.get(key) };
  }
  return null;
}
async function createTab(user, agent, url) {
  const mine = [...tabs.values()].filter((t) => t.user === user);
  if (mine.length >= MAX_TABS) throw new Error(`tab limit reached (${MAX_TABS} for this user)`);
  if (mine.filter((t) => t.agent === agent).length >= MAX_TABS_PER_AGENT) throw new Error(`agent tab limit reached (${MAX_TABS_PER_AGENT})`);
  const browser = await acquireBrowser();
  await browser.readyPromise; // a starting browser answers only after CDP is up
  const contextId = await ensureContext(browser, user, agent);
  const { targetId } = await browser.cdp.send("Target.createTarget", { url: "about:blank", browserContextId: contextId });
  const sessionId = await browser.cdp.attach(targetId);
  const tabId = `b${browser.id}:${targetId}`;
  const tab = { tabId, user, agent, browser, targetId, sessionId, url: "about:blank", title: "", createdAt: Date.now() };
  tabs.set(tabId, tab);
  browser.tabs.add(tabId);
  try {
    if (url) {
      const href = await assertPublicUrl(url);
      await browser.cdp.navigate(sessionId, href);
      const info = await browser.cdp.read(sessionId);
      tab.url = info.url; tab.title = info.title;
    }
  } catch (e) {
    // Never leak a half-opened tab: close it and remove the registry
    // entry, so a failed open does not consume the agent's tab quota.
    await closeTab(tab);
    throw e;
  }
  return tab;
}
function publicTab(t) {
  return { tabId: t.tabId, user: t.user, agent: t.agent, url: t.url, title: t.title, createdAt: t.createdAt };
}
function ownTab(user, agent, tabId) {
  const t = tabs.get(tabId);
  if (!t) throw new Error("tab not found");
  if (t.user !== user) throw new Error("tab belongs to another user");
  if (agent && t.agent !== agent) throw new Error("tab belongs to another agent");
  return t;
}
async function closeTab(t) {
  try { await t.browser.cdp.send("Target.closeTarget", { targetId: t.targetId }); } catch { /* gone */ }
  tabs.delete(t.tabId);
  t.browser.tabs.delete(t.tabId);
}

function sendJson(res, obj, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let s = "";
    req.on("data", (c) => { s += c; });
    req.on("end", () => {
      try { resolve(JSON.parse(s || "{}")); } catch { resolve({}); }
    });
  });
}
const server = http.createServer(async (req, res) => {
  try {
    if (req.headers["x-browser-token"] !== TOKEN) return sendJson(res, { error: "unauthorized" }, 401);
    const u = new URL(req.url, "http://127.0.0.1");
    const parts = u.pathname.split("/").filter(Boolean);
    const b = req.method === "POST" || req.method === "DELETE" ? await readBody(req) : {};
    if (req.method === "GET" && u.pathname === "/health") {
      return sendJson(res, {
        up: true,
        transport: "pipe",
        tabs: tabs.size,
        chrome: chromeBin,
        browsers: browsers.filter((x) => !x.dead).map((x) => ({ id: `b${x.id}`, tabs: x.tabs.size, contexts: x.contexts.size, servedContexts: x.servedContexts, ageMin: Math.round((Date.now() - x.createdAt) / 60000), rssMb: x.rssMb })),
        events: [...events].reverse().slice(0, 10),
      });
    }
    if (req.method === "GET" && parts[0] === "tabs" && parts.length === 1) {
      const user = u.searchParams.get("user") || "";
      const agent = u.searchParams.get("agent") || "";
      return sendJson(res, [...tabs.values()].filter((t) => t.user === user && (!agent || t.agent === agent)).map(publicTab));
    }
    if (req.method === "POST" && parts[0] === "tabs" && parts.length === 1) {
      if (!b.user || !b.agent) return sendJson(res, { error: "user + agent required" }, 400);
      const tab = await createTab(b.user, b.agent, b.url || "");
      return sendJson(res, publicTab(tab));
    }
    if (parts[0] === "tabs" && parts.length === 2 && req.method === "DELETE") {
      const tabId = decodeURIComponent(parts[1]);
      const t = ownTab(b.user, b.agent, tabId);
      await closeTab(t);
      return sendJson(res, { closed: tabId });
    }
    if (parts[0] === "tabs" && parts.length === 3) {
      const tabId = decodeURIComponent(parts[1]);
      const action = parts[2];
      if (req.method === "POST" && action === "navigate") {
        const t = ownTab(b.user, b.agent, tabId);
        const href = await assertPublicUrl(b.url || "");
        await t.browser.cdp.navigate(t.sessionId, href);
        const info = await t.browser.cdp.read(t.sessionId);
        t.url = info.url; t.title = info.title;
        return sendJson(res, publicTab(t));
      }
      if (req.method === "GET" && action === "read") {
        const t = ownTab(u.searchParams.get("user"), u.searchParams.get("agent"), tabId);
        const info = await t.browser.cdp.read(t.sessionId);
        t.url = info.url; t.title = info.title;
        return sendJson(res, info);
      }
      if (req.method === "POST" && action === "screenshot") {
        const t = ownTab(b.user, b.agent, tabId);
        const jpeg = await t.browser.cdp.screenshot(t.sessionId);
        return sendJson(res, { imageBase64: jpeg, format: "jpeg" });
      }
    }
    if (req.method === "POST" && parts[0] === "contexts" && parts.length === 3 && parts[2] === "close") {
      const user = decodeURIComponent(parts[1]);
      const agent = b.agent || "";
      for (const t of [...tabs.values()]) {
        if (t.user === user && (!agent || t.agent === agent)) await closeTab(t);
      }
      const found = findContextBrowser(user, agent);
      if (found) {
        try { await found.browser.cdp.send("Target.disposeBrowserContext", { browserContextId: found.contextId }); } catch { /* gone */ }
        found.browser.contexts.delete(`${user}/${agent}`);
      }
      return sendJson(res, { closed: true });
    }
    return sendJson(res, { error: "not found" }, 404);
  } catch (e) {
    return sendJson(res, { error: String(e.message || e) }, 400);
  }
});
server.listen(PORT, "127.0.0.1", () => {
  console.log(`BROWSER_DAEMON_READY ${PORT}`);
});
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  try { relay?.server.close(); } catch { /* gone */ }
  for (const b of browsers) killBrowser(b);
  setTimeout(() => process.exit(0), 3000);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
