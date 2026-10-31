// Built-in browser plugin: real computer operations on a real Chromium,
// through the browser daemon (server/browser-daemon.mjs). Every call is
// scoped to the caller's (user, agent); tabs of other users/agents are
// invisible and untouchable. Only public http(s) URLs are allowed — the
// daemon refuses localhost and private addresses (SSRF guard).
// This plugin never enters credentials, never logs in anywhere, and never
// touches a third-party learning platform: it opens pages the user chose
// and reads what is publicly visible there.
import fs from "node:fs";
import path from "node:path";

function daemonEnv() {
  const url = process.env.MOLATUBE_BROWSER_URL || "";
  const token = process.env.MOLATUBE_BROWSER_TOKEN || "";
  if (!url || !token) throw new Error("browser engine is not available (daemon down or MOLATUBE_BROWSER=0)");
  return { url, token };
}
async function call(p, method, body, query = "") {
  const { url, token } = daemonEnv();
  const r = await fetch(url + p + query, {
    method,
    headers: { "Content-Type": "application/json", "X-Browser-Token": token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `browser daemon ${r.status}`);
  return d;
}
function jail(workspace, rel) {
  const full = path.resolve(workspace, rel);
  if (full !== workspace && !full.startsWith(workspace + path.sep)) throw new Error("path escape rejected");
  return full;
}

export default function BrowserTools() {
  return {
    tool: {
      browser_tabs: {
        description: "List this agent's open browser tabs.",
        args: { type: "object", properties: {} },
        async execute(args, ctx) {
          return call("/tabs", "GET", undefined, `?user=${encodeURIComponent(ctx.user || "demo-user")}&agent=${encodeURIComponent(ctx.agent || "molatube")}`);
        },
      },
      browser_open_tab: {
        description: "Open a new real browser tab (public http(s) URL only). Returns the tab id, url and title.",
        args: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
        async execute(args, ctx) {
          return call("/tabs", "POST", { user: ctx.user || "demo-user", agent: ctx.agent || "molatube", url: args.url });
        },
      },
      browser_close_tab: {
        description: "Close one of this agent's tabs.",
        args: { type: "object", properties: { tabId: { type: "string" } }, required: ["tabId"] },
        async execute(args, ctx) {
          return call(`/tabs/${encodeURIComponent(args.tabId)}`, "DELETE", { user: ctx.user || "demo-user", agent: ctx.agent || "molatube" });
        },
      },
      browser_navigate: {
        description: "Navigate one of this agent's tabs to a public URL.",
        args: { type: "object", properties: { tabId: { type: "string" }, url: { type: "string" } }, required: ["tabId", "url"] },
        async execute(args, ctx) {
          return call(`/tabs/${encodeURIComponent(args.tabId)}/navigate`, "POST", { user: ctx.user || "demo-user", agent: ctx.agent || "molatube", url: args.url });
        },
      },
      browser_read: {
        description: "Read one of this agent's tabs: title, url and visible text (first 4000 chars).",
        args: { type: "object", properties: { tabId: { type: "string" } }, required: ["tabId"] },
        async execute(args, ctx) {
          return call(`/tabs/${encodeURIComponent(args.tabId)}/read`, "GET", undefined, `?user=${encodeURIComponent(ctx.user || "demo-user")}&agent=${encodeURIComponent(ctx.agent || "molatube")}`);
        },
      },
      browser_screenshot: {
        description: "Screenshot one of this agent's tabs (viewport JPEG q75) and save it into the job workspace.",
        args: { type: "object", properties: { tabId: { type: "string" } }, required: ["tabId"] },
        async execute(args, ctx) {
          const d = await call(`/tabs/${encodeURIComponent(args.tabId)}/screenshot`, "POST", { user: ctx.user || "demo-user", agent: ctx.agent || "molatube" });
          const b64 = d.imageBase64 || d.pngBase64 || "";
          if (!b64) throw new Error("screenshot came back empty");
          if (!ctx.workspace) throw new Error("no workspace in context");
          const safe = args.tabId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 16);
          const rel = `screenshots/${safe}-${Date.now()}.jpg`;
          const full = jail(ctx.workspace, rel);
          fs.mkdirSync(path.dirname(full), { recursive: true });
          fs.writeFileSync(full, Buffer.from(b64, "base64"));
          return { relPath: rel, size: fs.statSync(full).size, format: "jpeg" };
        },
      },
    },
  };
}
