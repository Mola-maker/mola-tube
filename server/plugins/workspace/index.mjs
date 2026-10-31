// Built-in workspace plugin: real file effects inside one job workspace.
// Writes are jailed to ctx.workspace; snapshots hash every file (excluding
// the snapshots/ dir itself) and report logical vs unique bytes, so the
// dedup ratio is a measured number, not a claim.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function jail(workspace, rel) {
  if (!workspace) throw new Error("no workspace in context");
  const full = path.resolve(workspace, rel);
  if (full !== workspace && !full.startsWith(workspace + path.sep)) throw new Error("path escape rejected");
  return full;
}

function walk(dir, base = "") {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (rel === "snapshots" || rel.startsWith("snapshots/")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full, rel));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

const sha = (buf) => createHash("sha256").update(buf).digest("hex");

export default function WorkspaceTools() {
  return {
    tool: {
      workspace_write: {
        description: "Write a file inside the job workspace, return its sha256 and size.",
        args: { type: "object", properties: { relPath: { type: "string" }, content: { type: "string" } }, required: ["relPath", "content"] },
        async execute(args, ctx) {
          const full = jail(ctx.workspace, args.relPath);
          fs.mkdirSync(path.dirname(full), { recursive: true });
          fs.writeFileSync(full, String(args.content ?? ""));
          const buf = fs.readFileSync(full);
          return { relPath: args.relPath, sha256: sha(buf), size: buf.length };
        },
      },
      workspace_read: {
        description: "Read a file inside the job workspace.",
        args: { type: "object", properties: { relPath: { type: "string" } }, required: ["relPath"] },
        async execute(args, ctx) {
          const full = jail(ctx.workspace, args.relPath);
          return { relPath: args.relPath, content: fs.readFileSync(full, "utf8") };
        },
      },
      workspace_list: {
        description: "List files inside the job workspace.",
        args: { type: "object", properties: {} },
        async execute(args, ctx) {
          fs.mkdirSync(ctx.workspace, { recursive: true });
          return { files: walk(ctx.workspace) };
        },
      },
      workspace_snapshot: {
        description: "Snapshot the workspace: hash every file, record the manifest, report logical vs unique bytes.",
        args: { type: "object", properties: { message: { type: "string" } } },
        async execute(args, ctx) {
          fs.mkdirSync(ctx.workspace, { recursive: true });
          const files = walk(ctx.workspace);
          const entries = files.map((rel) => {
            const buf = fs.readFileSync(path.join(ctx.workspace, rel));
            return { rel, sha256: sha(buf), size: buf.length };
          });
          const unique = new Map();
          let logical = 0;
          for (const e of entries) { logical += e.size; if (!unique.has(e.sha256)) unique.set(e.sha256, e.size); }
          const uniqueBytes = [...unique.values()].reduce((a, b) => a + b, 0);
          const manifest = { at: Date.now(), message: args.message || "", files: entries, logicalBytes: logical, uniqueBytes, dedupRatio: logical ? Number((uniqueBytes / logical).toFixed(3)) : 1 };
          const dir = path.join(ctx.workspace, "snapshots");
          fs.mkdirSync(dir, { recursive: true });
          const name = `${manifest.at}.json`;
          fs.writeFileSync(path.join(dir, name), JSON.stringify(manifest, null, 2));
          return { snapshot: name, ...manifest };
        },
      },
    },
  };
}
