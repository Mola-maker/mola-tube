// Shared task execution: used by worker.mjs (one fork per job) and by
// pool-worker.mjs (one long-lived process serving many jobs). The only
// difference is who loads the plugins and who owns the process lifetime.
// runJob returns the result string; it throws on failure, and throws an
// Error with code "CANCELLED" when shouldCancel() becomes true between
// steps. External text (titles, descriptions) is DATA, never instructions.
import { loadPlugins, allPluginDirs, findPlugin } from "./plugins.mjs";

export class CancelledError extends Error {
  constructor() { super("cancelled"); this.code = "CANCELLED"; }
}

const TYPES = ["summary", "qa", "notes", "quiz", "plugin"];

function toolOf(plugins, plugin, tool) {
  const p = findPlugin(plugins, plugin);
  if (!p) throw new Error(`plugin not found: ${plugin}`);
  if (p.error) throw new Error(`plugin failed to load: ${p.error}`);
  const t = p.tools[tool];
  if (!t) throw new Error(`tool not found: ${plugin}/${tool}`);
  return t;
}

export async function runJob(assignment, ctx, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const shouldCancel = opts.shouldCancel || (() => false);
  const checkCancel = () => { if (shouldCancel()) throw new CancelledError(); };
  const type = TYPES.includes(assignment.type) ? assignment.type : "summary";
  const videoId = assignment.videoId || "v1";
  const question = assignment.question || "";
  const plugins = opts.plugins || (await loadPlugins(allPluginDirs()));
  const video = toolOf(plugins, "video", "video_inspect");
  const write = toolOf(plugins, "workspace", "workspace_write");
  const snapshot = toolOf(plugins, "workspace", "workspace_snapshot");

  if (type === "plugin") {
    if (!assignment.plugin || !assignment.tool) throw new Error("plugin jobs need plugin + tool");
    onProgress(10, `调用插件 ${assignment.plugin}/${assignment.tool}`);
    const tool = toolOf(plugins, assignment.plugin, assignment.tool);
    let args = {};
    try { args = typeof assignment.args === "string" ? JSON.parse(assignment.args) : (assignment.args || {}); }
    catch { throw new Error("args must be valid JSON"); }
    const result = await tool.execute(args, ctx);
    checkCancel();
    await write.execute({ relPath: "result.json", content: JSON.stringify(result, null, 2) }, ctx);
    onProgress(80, "写入结果并快照");
    const snap = await snapshot.execute({ message: `plugin ${assignment.plugin}/${assignment.tool}` }, ctx);
    checkCancel();
    const text = `完成：插件任务 ${assignment.plugin}/${assignment.tool}，快照 ${snap.snapshot}（${snap.files.length} 个文件，逻辑 ${snap.logicalBytes} 字节，去重后 ${snap.uniqueBytes} 字节）。`;
    await write.execute({ relPath: "result.txt", content: text }, ctx);
    return text;
  }

  onProgress(20, "读取视频信息");
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

  onProgress(60, "写入任务产物");
  const outName = type === "qa" ? "answer.md" : type === "quiz" ? "quiz.md" : type === "notes" ? "notes.md" : "summary.md";
  await write.execute({ relPath: outName, content }, ctx);
  checkCancel();
  onProgress(85, "快照工作区");
  const snap = await snapshot.execute({ message: `${type} ${videoId}` }, ctx);
  checkCancel();
  const result = `完成：${type}（视频 ${videoId}，${info.title}），产物 ${outName}，快照 ${snap.snapshot}（${snap.files.length} 个文件）。`;
  await write.execute({ relPath: "result.txt", content: result }, ctx);
  return result;
}
