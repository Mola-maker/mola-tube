// v1.1 execution-plane worker: one child process per job.
// Real execution, no simulated steps: the worker runs built-in plugin
// tools (video inspect + workspace write/snapshot) over real catalog data,
// or a named plugin tool for type=plugin jobs. Every step writes a real
// artifact into the job workspace; progress reports follow real steps.
// External text (titles, descriptions) is DATA, never instructions.
// QA answers and quiz questions are template-generated from real catalog
// data and are labeled as such; no LLM is called in v1.1.
import fs from "node:fs";
import path from "node:path";
import { loadPlugins, allPluginDirs, findPlugin } from "./plugins.mjs";

const send = (msg) => { if (process.send) process.send(msg); };
// Terminal messages must be flushed before exit: process.send() is async,
// and process.exit() right after it can drop the message (seen under load
// as "worker exited code 0" with no result). The callback fires after flush.
const done = (msg) => { if (process.send) process.send(msg, () => process.exit(0)); else process.exit(0); };
const TYPES = ["summary", "qa", "notes", "quiz", "plugin"];

const jobId = process.env.MOLATUBE_JOB_ID;
const agentId = process.env.MOLATUBE_AGENT_ID || "";
const type = TYPES.includes(process.env.MOLATUBE_TYPE) ? process.env.MOLATUBE_TYPE : "summary";
const videoId = process.env.MOLATUBE_VIDEO_ID || "v1";
const workspace = process.env.MOLATUBE_WORKSPACE;
const question = process.env.MOLATUBE_QUESTION || "";
const pluginName = process.env.MOLATUBE_PLUGIN || "";
const toolName = process.env.MOLATUBE_TOOL || "";
const argsJson = process.env.MOLATUBE_ARGS_JSON || "{}";

if (!jobId || !workspace) {
  console.error("worker: missing MOLATUBE_JOB_ID / MOLATUBE_WORKSPACE");
  process.exit(2);
}
fs.mkdirSync(workspace, { recursive: true });
if (process.env.MAGPIE_LAYERFS_HOME) process.env.MAGPIE_LAYERFS_HOME = process.env.MAGPIE_LAYERFS_HOME;
if (process.env.MAGPIE_LAYERFS_PAGE_DIR) process.env.MAGPIE_LAYERFS_PAGE_DIR = process.env.MAGPIE_LAYERFS_PAGE_DIR;

let cancelled = false;
process.on("SIGTERM", () => { cancelled = true; });
const checkCancel = () => {
  if (cancelled) done({ kind: "cancelled" });
};

const ctx = {
  agent: agentId || "molatube",
  workspace,
  directory: path.resolve(import.meta.dirname, "data"),
};

function toolOf(plugins, plugin, tool) {
  const p = findPlugin(plugins, plugin);
  if (!p) throw new Error(`plugin not found: ${plugin}`);
  if (p.error) throw new Error(`plugin failed to load: ${p.error}`);
  const t = p.tools[tool];
  if (!t) throw new Error(`tool not found: ${plugin}/${tool}`);
  return t;
}

try {
  const plugins = await loadPlugins(allPluginDirs());
  const video = toolOf(plugins, "video", "video_inspect");
  const write = toolOf(plugins, "workspace", "workspace_write");
  const snapshot = toolOf(plugins, "workspace", "workspace_snapshot");

  if (type === "plugin") {
    if (!pluginName || !toolName) throw new Error("plugin jobs need plugin + tool");
    send({ kind: "progress", progress: 10, step: `调用插件 ${pluginName}/${toolName}` });
    const tool = toolOf(plugins, pluginName, toolName);
    let args = {};
    try { args = JSON.parse(argsJson); } catch { throw new Error("args must be valid JSON"); }
    const result = await tool.execute(args, ctx);
    checkCancel();
    await write.execute({ relPath: "result.json", content: JSON.stringify(result, null, 2) }, ctx);
    send({ kind: "progress", progress: 80, step: "写入结果并快照" });
    const snap = await snapshot.execute({ message: `plugin ${pluginName}/${toolName}` }, ctx);
    checkCancel();
    const text = `完成：插件任务 ${pluginName}/${toolName}，快照 ${snap.snapshot}（${snap.files.length} 个文件，逻辑 ${snap.logicalBytes} 字节，去重后 ${snap.uniqueBytes} 字节）。`;
    await write.execute({ relPath: "result.txt", content: text }, ctx);
    done({ kind: "done", result: text });
  }

  send({ kind: "progress", progress: 20, step: "读取视频信息" });
  const info = await video.execute({ videoId }, ctx);
  checkCancel();

  let content = "";
  if (type === "summary") {
    content = `# 总结：${info.title}\n\n- 作者：${info.author}\n- 时长：${info.time}（${info.durationSec} 秒）\n- 简介：${info.desc}\n- 关键词：${info.keywords.join("、") || "无"}\n\n> 由视频目录数据计算生成，未调用大模型。\n`;
  } else if (type === "notes") {
    content = `# 笔记：${info.title}\n\n## 概览\n${info.desc}\n\n## 要点\n- 作者：${info.author}，时长 ${info.time}\n- 关键词：${info.keywords.join("、") || "无"}\n\n## 自测提示\n对照关键词复述本节核心，再看一遍简介里没覆盖的部分。\n\n> 由视频目录数据整理生成，未调用大模型。\n`;
  } else if (type === "quiz") {
    const qs = info.keywords.slice(0, 3).map((kw, i) => `${i + 1}. 下列哪项与《${info.title}》最相关？\n   A. ${kw}\n   B. 与本节无关的干扰项（模板生成）\n   参考答案：A（关键词：${kw}）`);
    content = `# 自测题：${info.title}\n\n${qs.length ? qs.join("\n\n") : "关键词不足，无法生成题目。"}\n\n> 模板生成自测题（取自真实视频关键词），仅供自学，不代表考试题。\n`;
  } else if (type === "qa") {
    content = `# 答疑：${info.title}\n\n问题：${question || "（未提供问题）"}\n\n回答：${question ? `结合本视频简介与关键词（${info.keywords.join("、") || "无"}）来看：${info.desc} 建议先对照简介复述一遍，再带着问题重看对应片段。` : "请在创建任务时附上问题，Agent 会结合本视频的信息作答。"}\n\n> 模板回答（未调用大模型），仅供自学参考。\n`;
  }

  send({ kind: "progress", progress: 60, step: "写入任务产物" });
  const outName = type === "qa" ? "answer.md" : type === "quiz" ? "quiz.md" : type === "notes" ? "notes.md" : "summary.md";
  await write.execute({ relPath: outName, content }, ctx);
  checkCancel();
  send({ kind: "progress", progress: 85, step: "快照工作区" });
  const snap = await snapshot.execute({ message: `${type} ${videoId}` }, ctx);
  checkCancel();
  const result = `完成：${type}（视频 ${videoId}，${info.title}），产物 ${outName}，快照 ${snap.snapshot}（${snap.files.length} 个文件）。`;
  await write.execute({ relPath: "result.txt", content: result }, ctx);
  done({ kind: "done", result });
} catch (e) {
  console.error(`worker failed: ${e.message}`);
  process.exit(1);
}
