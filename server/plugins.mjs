// Real plugin loader. A plugin is a directory with an index.mjs that
// exports a factory (default export, or a named export ending in "Tools",
// e.g. magpie-layerfs' LayerfsTools) returning one of:
//   { tool: { name: { description, args, execute } } }   (magpie shape)
//   { tools: [...], call: (name, args) => ... }          (MolaTube plugin shape)
//   { name: { description, args, execute } }             (plain tools object)
// execute(args, ctx) runs with ctx = { agent, workspace, directory }.
// Directories: the shipped server/plugins/* plus MOLATUBE_PLUGIN_DIRS
// (colon-separated, e.g. a magpie-layerfs checkout). Loading a plugin
// never runs its tools; execution happens in a worker child (jobs) or in
// plugin-runner.mjs (direct calls), so a bad plugin cannot take down the
// control plane at load time beyond a failed import, which is reported.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function builtinPluginDirs() {
  const dir = path.resolve(import.meta.dirname, "plugins");
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(dir, d.name));
  } catch { return []; }
}

export function externalPluginDirs() {
  const raw = process.env.MOLATUBE_PLUGIN_DIRS || "";
  return raw.split(":").map((s) => s.trim()).filter(Boolean);
}

export function allPluginDirs() {
  return [...builtinPluginDirs(), ...externalPluginDirs()];
}

function asTools(result) {
  if (!result || typeof result !== "object") return null;
  if (result.tool && typeof result.tool === "object") return result.tool;
  if (Array.isArray(result.tools) && typeof result.call === "function") {
    const out = {};
    for (const t of result.tools) {
      out[t.name] = {
        description: t.description || "",
        args: t.inputSchema || { type: "object", properties: {} },
        execute: (args, ctx) => result.call(t.name, args, ctx),
      };
    }
    return out;
  }
  const entries = Object.entries(result).filter(([, v]) => v && typeof v.execute === "function");
  if (entries.length) return Object.fromEntries(entries);
  return null;
}

export async function loadPluginDir(dir) {
  const entry = path.join(dir, "index.mjs");
  if (!fs.existsSync(entry)) return null;
  const mod = await import(pathToFileURL(entry).href + `?v=${Date.now()}`);
  let factory = null;
  if (typeof mod.default === "function") factory = mod.default;
  else {
    for (const [k, v] of Object.entries(mod)) {
      if (typeof v === "function" && /Tools$/.test(k)) { factory = v; break; }
    }
  }
  let result = null;
  if (factory) {
    result = await factory({ agent: "molatube", directory: path.resolve(import.meta.dirname, "data") }, {});
  } else if (mod.tool || mod.tools) {
    result = mod;
  }
  const tools = asTools(result);
  if (!tools) return null;
  return { name: path.basename(dir), dir, tools };
}

export async function loadPlugins(dirs) {
  const out = [];
  for (const dir of dirs) {
    try {
      const p = await loadPluginDir(dir);
      if (p) out.push(p);
    } catch (e) {
      out.push({ name: path.basename(dir), dir, error: String(e.message), tools: {} });
    }
  }
  return out;
}

export function findPlugin(plugins, name) {
  return plugins.find((p) => p.name === name);
}
