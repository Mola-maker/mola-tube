// Isolated direct plugin-call runner: one child process per tool call.
// Env: PLUGIN_DIR, TOOL_NAME, ARGS_JSON, WORKSPACE, AGENT.
// Imports the plugin, executes the tool, reports {kind:'done', result}
// or {kind:'error', error} over IPC, then exits. A throwing or hanging
// plugin therefore fails the call, never the control plane (the parent
// enforces a 30s timeout and kills the child).
import { loadPluginDir } from "./plugins.mjs";

// Flush-before-exit, same as worker.mjs: a terminal message sent right
// before process.exit() can be dropped under load.
const done = (msg, code) => { if (process.send) process.send(msg, () => process.exit(code)); else process.exit(code); };
try {
  const plugin = await loadPluginDir(process.env.PLUGIN_DIR || "");
  if (!plugin || plugin.error) throw new Error(plugin?.error || "plugin not found");
  const tool = plugin.tools[process.env.TOOL_NAME || ""];
  if (!tool) throw new Error(`tool not found: ${process.env.TOOL_NAME}`);
  const args = JSON.parse(process.env.ARGS_JSON || "{}");
  const result = await tool.execute(args, {
    agent: process.env.AGENT || "molatube",
    workspace: process.env.WORKSPACE || "",
    directory: process.env.MOLATUBE_DATA_DIR || "",
  });
  done({ kind: "done", result }, 0);
} catch (e) {
  done({ kind: "error", error: String(e.message || e) }, 1);
}
