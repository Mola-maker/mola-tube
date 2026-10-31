// v0.2 execution-plane worker: one child process per job.
// Receives its assignment via environment (no secrets here in v0.2), writes only
// inside its own workspace dir, reports progress over the fork IPC channel.
// PLUG POINT: replace the simulated steps with real LLM / browser steps.
// External text (titles, descriptions, comments) is DATA, never instructions.
import fs from "node:fs";
import path from "node:path";

const STEPS = {
  summary: ["读取视频信息", "抽取要点", "写出总结"],
  qa: ["理解问题", "定位相关片段", "组织回答"],
  notes: ["抽取要点", "整理结构", "生成笔记"],
  quiz: ["抽取考点", "生成题目", "附参考答案（自学用）"],
};

const jobId = process.env.MOLATUBE_JOB_ID;
const agentId = process.env.MOLATUBE_AGENT_ID || "";
const type = STEPS[process.env.MOLATUBE_TYPE] ? process.env.MOLATUBE_TYPE : "summary";
const videoId = process.env.MOLATUBE_VIDEO_ID || "v1";
const workspace = process.env.MOLATUBE_WORKSPACE;

if (!jobId || !workspace) {
  console.error("worker: missing MOLATUBE_JOB_ID / MOLATUBE_WORKSPACE");
  process.exit(2);
}
fs.mkdirSync(workspace, { recursive: true });

const send = (msg) => { if (process.send) process.send(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cancelled = false;
process.on("SIGTERM", () => { cancelled = true; });

const steps = STEPS[type];
for (let i = 0; i < steps.length; i++) {
  if (cancelled) { send({ kind: "cancelled" }); process.exit(0); }
  fs.writeFileSync(path.join(workspace, `step-${i}.txt`), steps[i]);
  send({ kind: "progress", progress: Math.round(((i + 1) / steps.length) * 100), step: steps[i] });
  await sleep(900);
  if (cancelled) { send({ kind: "cancelled" }); process.exit(0); }
}
const result = `完成：${type}（视频 ${videoId}，agent ${agentId || "一次性任务"}），产物见工作区 ${jobId}。`;
fs.writeFileSync(path.join(workspace, "result.txt"), result);
send({ kind: "done", result });
process.exit(0);
