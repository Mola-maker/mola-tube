// Channel registry for the v1.0 control plane (newapi-style "渠道" concept,
// adapted to execution channels, not model providers).
// A channel is one way to run a job: local (fork worker.mjs directly) or
// magpie (same worker, reached through the Magpie tool-call adapter in
// magpie-runner.mjs: schema-validated tool envelope + audit + forwarding).
// Routing: enabled channels sorted by priority asc, then weight desc;
// the first one wins. Weight is a same-priority tiebreaker in v1.0.
// Built-in channels can be disabled but not deleted; custom channels
// (same two types) can be added, edited and deleted.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const FILE = path.resolve(import.meta.dirname, "data", "channels.json");
export const CHANNEL_TYPES = ["local", "magpie"];

export function defaultChannels() {
  const now = Date.now();
  return [
    { id: "local", name: "本地执行", type: "local", enabled: true, priority: 1, weight: 100, concurrency: 0, endpoint: null, builtin: true, createdAt: now },
    { id: "magpie", name: "Magpie 通道", type: "magpie", enabled: true, priority: 2, weight: 100, concurrency: 0, endpoint: process.env.MAGPIE_ENDPOINT || null, builtin: true, createdAt: now },
  ];
}

export function loadChannels() {
  try {
    const list = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (Array.isArray(list) && list.length) return list;
  } catch { /* fall through to defaults */ }
  const d = defaultChannels();
  saveChannels(d);
  return d;
}

export function saveChannels(list) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, FILE);
}

export function routeChannel(channels) {
  const enabled = channels.filter((c) => c.enabled).sort((a, b) => (a.priority - b.priority) || (b.weight - a.weight));
  return enabled[0] || null;
}

export function newChannel({ name, type, priority, weight, endpoint }) {
  if (!CHANNEL_TYPES.includes(type)) throw new Error("channel type must be local or magpie");
  return { id: randomUUID(), name: String(name || `${type} 通道`).slice(0, 64), type, enabled: true, priority: Number(priority) || 10, weight: Number(weight) || 100, concurrency: 0, endpoint: endpoint ? String(endpoint).slice(0, 512) : null, builtin: false, createdAt: Date.now() };
}
