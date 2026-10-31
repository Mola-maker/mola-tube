// Built-in video plugin: real, deterministic computation over the video
// catalog (no LLM, no invented facts). The catalog is server/videos.default.json,
// overridden by server/data/videos.json when present.
import fs from "node:fs";
import path from "node:path";

function catalogPath(ctx) {
  const data = path.resolve(ctx.directory || "", "videos.json");
  if (data && fs.existsSync(data)) return data;
  return path.resolve(import.meta.dirname, "..", "..", "videos.default.json");
}

function loadCatalog(ctx) {
  try {
    const raw = JSON.parse(fs.readFileSync(catalogPath(ctx), "utf8"));
    if (Array.isArray(raw)) return raw;
    if (Array.isArray(raw.videos)) return raw.videos;
  } catch { /* fall through */ }
  return [];
}

function durationSec(time) {
  const m = String(time || "").match(/(\d+):(\d+)/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

// Keywords: CJK sequences (>=2 chars) and latin words, by frequency.
function keywords(text) {
  const cjk = (String(text).match(/[\u4e00-\u9fff]{2,}/g) || []);
  const latin = (String(text).match(/[A-Za-z][A-Za-z0-9+]{1,}/g) || []).map((w) => w.toLowerCase());
  const freq = new Map();
  for (const w of [...cjk, ...latin]) freq.set(w, (freq.get(w) || 0) + 1);
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([w]) => w);
}

function inspectOne(v) {
  const text = `${v.title} ${v.desc || ""}`;
  return {
    ...v,
    durationSec: durationSec(v.time),
    descChars: (v.desc || "").length,
    keywords: keywords(text),
  };
}

export default function VideoTools() {
  return {
    tool: {
      video_catalog: {
        description: "List the video catalog.",
        args: { type: "object", properties: {} },
        async execute(args, ctx) {
          return loadCatalog(ctx).map((v) => ({ id: v.id, title: v.title, author: v.author, time: v.time }));
        },
      },
      video_inspect: {
        description: "Inspect one video: catalog entry plus computed duration, description length and keywords.",
        args: { type: "object", properties: { videoId: { type: "string" } }, required: ["videoId"] },
        async execute(args, ctx) {
          const v = loadCatalog(ctx).find((x) => x.id === args.videoId);
          if (!v) throw new Error(`video not found: ${args.videoId}`);
          return inspectOne(v);
        },
      },
      video_search: {
        description: "Search the catalog by title/author substring.",
        args: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        async execute(args, ctx) {
          const q = String(args.query || "");
          return loadCatalog(ctx).filter((v) => v.title.includes(q) || v.author.includes(q)).map((v) => ({ id: v.id, title: v.title, author: v.author, time: v.time }));
        },
      },
    },
  };
}
