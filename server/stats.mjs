// Dashboard statistics, computed from control-plane state only.
// No external calls, no invented numbers: every figure is a count over
// the stored agents/jobs/events.
export function computeStats(state) {
  const byStatus = {};
  const byType = {};
  const byChannel = {};
  for (const j of state.jobs) {
    byStatus[j.status] = (byStatus[j.status] || 0) + 1;
    byType[j.type] = (byType[j.type] || 0) + 1;
    byChannel[j.channel || "unrouted"] = (byChannel[j.channel || "unrouted"] || 0) + 1;
  }
  const agentByStatus = {};
  for (const a of state.agents) agentByStatus[a.status] = (agentByStatus[a.status] || 0) + 1;
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    d.setHours(0, 0, 0, 0);
    const next = d.getTime() + 86400000;
    const date = d.toISOString().slice(0, 10);
    const count = state.jobs.filter((j) => {
      const t = j.createdAt || j.startedAt || 0;
      return t >= d.getTime() && t < next;
    }).length;
    days.push({ date, count });
  }
  return {
    agents: { total: state.agents.length, byStatus: agentByStatus },
    jobs: { total: state.jobs.length, byStatus, byType, byChannel },
    running: state.jobs.filter((j) => j.status === "running").length,
    queued: state.jobs.filter((j) => j.status === "queued").length,
    last14Days: days,
  };
}
