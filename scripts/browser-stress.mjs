// Browser concurrency test: N agents in parallel, each opens a tab, reads
// it, screenshots it, closes it. Then isolation checks: one agent must not
// see or close another agent's tab. Usage: node scripts/browser-stress.mjs [agents]
// Base URL from MOLATUBE_URL (default http://localhost:3000).
const BASE = process.env.MOLATUBE_URL || "http://localhost:3000";
const N = Number(process.argv[2] || 3);
async function api(method, p, body) {
  const r = await fetch(BASE + p, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${p} -> ${d.error || r.status}`);
  return d;
}
const started = Date.now();
const results = await Promise.allSettled(Array.from({ length: N }, async (_, i) => {
  const agent = `stress-agent-${i}`;
  const tab = await api("POST", "/api/browser/open", { url: "https://example.com", agentId: agent });
  const read = await api("GET", `/api/browser/${encodeURIComponent(tab.tabId)}/read?agentId=${agent}`);
  if (read.title !== "Example Domain") throw new Error(`unexpected title: ${read.title}`);
  const shot = await api("POST", `/api/browser/${encodeURIComponent(tab.tabId)}/screenshot`, { agentId: agent });
  if (!shot.imageBase64 || !shot.imageBase64.startsWith("/9j/")) throw new Error("screenshot is not JPEG");
  await api("POST", `/api/browser/${encodeURIComponent(tab.tabId)}/close`, { agentId: agent });
  return agent;
}));
const ok = results.filter((r) => r.status === "fulfilled").length;
const failed = results.filter((r) => r.status === "rejected");
for (const f of failed) console.log("FAILED:", f.reason.message);
// Isolation: open a tab as agent X, then agent Y must not see or close it.
const x = await api("POST", "/api/browser/open", { url: "https://example.com", agentId: "iso-x" });
const yTabs = await api("GET", "/api/browser/tabs?user=demo-user&agent=iso-y");
const ySeesX = yTabs.some((t) => t.tabId === x.tabId);
let yCloseBlocked = false;
try { await api("POST", `/api/browser/${encodeURIComponent(x.tabId)}/close`, { agentId: "iso-y" }); }
catch (e) { yCloseBlocked = /another agent/.test(e.message); }
await api("POST", `/api/browser/${encodeURIComponent(x.tabId)}/close`, { agentId: "iso-x" });
const remaining = await api("GET", "/api/browser/tabs");
console.log(JSON.stringify({
  agents: N, ok, failed: failed.length,
  isolation: { ySeesX, yCloseBlocked },
  tabsRemaining: remaining.length,
  totalMs: Date.now() - started,
}, null, 2));
process.exit(ok === N && !ySeesX && yCloseBlocked && remaining.length === 0 ? 0 : 1);
