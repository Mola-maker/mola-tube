// MolaTube tools for Magpie. Shape follows the magpie plugin convention:
// a factory taking the calling context and options, returning tool
// definitions (JSON Schema arguments, zero dependencies) plus a call()
// dispatcher. The calling agent comes from ctx.agent and is recorded by
// the control plane as the job's user where the API accepts it.
//
// Backend: the MolaTube control plane over HTTP. MOLATUBE_URL defaults to
// http://localhost:3000; MOLATUBE_API_KEY (or options.apiKey) authenticates
// as a key owner. If the server is unreachable the tool returns an honest
// error, never invented state.
const TYPES = ["summary", "qa", "notes", "quiz"];

export const TOOLS = [
  { name: "molatube_agent_create", description: "Create a MolaTube agent (user-initiated learning tasks only).", inputSchema: { type: "object", properties: { name: { type: "string" }, type: { type: "string", enum: TYPES }, videoId: { type: "string" } }, required: ["type"] } },
  { name: "molatube_agent_start", description: "Start an agent's next job.", inputSchema: { type: "object", properties: { agentId: { type: "string" } }, required: ["agentId"] } },
  { name: "molatube_agent_pause", description: "Pause an agent after its current job finishes.", inputSchema: { type: "object", properties: { agentId: { type: "string" } }, required: ["agentId"] } },
  { name: "molatube_agent_stop", description: "Stop an agent and cancel its queued/running jobs.", inputSchema: { type: "object", properties: { agentId: { type: "string" } }, required: ["agentId"] } },
  { name: "molatube_agent_retry", description: "Retry an agent's failed or interrupted job.", inputSchema: { type: "object", properties: { agentId: { type: "string" } }, required: ["agentId"] } },
  { name: "molatube_agent_status", description: "Get an agent and its jobs.", inputSchema: { type: "object", properties: { agentId: { type: "string" } }, required: ["agentId"] } },
  { name: "molatube_job_list", description: "List jobs, optionally filtered by status.", inputSchema: { type: "object", properties: { status: { type: "string" } } } },
  { name: "molatube_run_job", description: "Run a one-shot job and wait for its result (polls up to 120s).", inputSchema: { type: "object", properties: { type: { type: "string", enum: TYPES }, videoId: { type: "string" } }, required: ["type", "videoId"] } },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const MolatubeTools = (ctx = {}, options = {}) => {
  const baseUrl = (options.baseUrl || process.env.MOLATUBE_URL || "http://localhost:3000").replace(/\/$/, "");
  const apiKey = options.apiKey || process.env.MOLATUBE_API_KEY || "";
  const headers = { "Content-Type": "application/json", ...(apiKey ? { "X-Api-Key": apiKey } : {}) };
  const req = async (method, p, body) => {
    let res;
    try {
      res = await fetch(baseUrl + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
    } catch (e) {
      throw new Error(`MolaTube server unreachable at ${baseUrl}: ${e.message}`);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `MolaTube API ${res.status}`);
    return data;
  };
  const call = async (name, args = {}) => {
    switch (name) {
      case "molatube_agent_create": return req("POST", "/api/agents", { name: args.name, type: args.type, videoId: args.videoId });
      case "molatube_agent_start": return req("POST", `/api/agents/${args.agentId}/start`);
      case "molatube_agent_pause": return req("POST", `/api/agents/${args.agentId}/pause`);
      case "molatube_agent_stop": return req("POST", `/api/agents/${args.agentId}/stop`);
      case "molatube_agent_retry": return req("POST", `/api/agents/${args.agentId}/retry`);
      case "molatube_agent_status": return req("GET", `/api/agents/${args.agentId}`);
      case "molatube_job_list": {
        const jobs = await req("GET", "/api/jobs");
        return args.status ? jobs.filter((j) => j.status === args.status) : jobs;
      }
      case "molatube_run_job": {
        const job = await req("POST", "/api/jobs", { type: args.type, videoId: args.videoId });
        for (let i = 0; i < 120; i++) {
          await sleep(1000);
          const jobs = await req("GET", "/api/jobs");
          const cur = jobs.find((j) => j.id === job.id);
          if (cur && ["done", "cancelled", "timeout", "failed", "interrupted"].includes(cur.status)) return cur;
        }
        throw new Error("molatube_run_job timed out waiting for the job");
      }
      default: throw new Error(`unknown tool: ${name}`);
    }
  };
  return { tools: TOOLS, call, callingAgent: typeof ctx?.agent === "string" ? ctx.agent : "" };
};
export default MolatubeTools;
