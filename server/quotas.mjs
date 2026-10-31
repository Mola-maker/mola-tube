// Per-user quotas, editable from the dashboard. maxJobsPerDay 0 = unlimited.
import fs from "node:fs";
import path from "node:path";

const FILE = path.resolve(import.meta.dirname, "data", "quotas.json");
export const DEFAULT_QUOTA = { maxAgents: 20, maxJobsPerDay: 0 };

export function loadQuotas() {
  try {
    const q = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (q && typeof q === "object") return q;
  } catch { /* defaults */ }
  return {};
}

export function saveQuotas(quotas) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(quotas, null, 2));
  fs.renameSync(tmp, FILE);
}

export function getQuota(quotas, user) {
  return { ...DEFAULT_QUOTA, ...(quotas[user] || {}) };
}

export function jobsToday(jobs, user) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return jobs.filter((j) => j.user === user && (j.createdAt || j.startedAt || 0) >= start.getTime()).length;
}
