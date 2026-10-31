// API keys (newapi-style 令牌): a key belongs to one user, carries a call
// quota, and is stored only as a SHA-256 hash. The plain key is shown once,
// at creation. Keys are presented masked everywhere else.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";

const FILE = path.resolve(import.meta.dirname, "data", "keys.json");

export function loadKeys() {
  try {
    const list = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (Array.isArray(list)) return list;
  } catch { /* empty */ }
  return [];
}

export function saveKeys(list) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, FILE);
}

const hash = (plain) => createHash("sha256").update(plain).digest("hex");

export function createKey({ name, owner, quota, expiresAt }) {
  const plain = `sk-mola-${randomBytes(16).toString("hex")}`;
  const record = {
    id: randomUUID(), name: String(name || "默认令牌").slice(0, 64), owner,
    prefix: plain.slice(0, 12), keyHash: hash(plain),
    quota: Number(quota) > 0 ? Number(quota) : 10000,
    used: 0, enabled: true,
    expiresAt: expiresAt ? Number(expiresAt) : null,
    createdAt: Date.now(),
  };
  return { record, plain };
}

export function verifyKey(keys, plain) {
  if (!plain) return null;
  const rec = keys.find((k) => k.keyHash === hash(plain));
  if (!rec || !rec.enabled) return null;
  if (rec.expiresAt && Date.now() > rec.expiresAt) return null;
  if (rec.used >= rec.quota) return null;
  return rec;
}

export function maskKey(k) {
  const { keyHash, ...rest } = k;
  return { ...rest, key: `${k.prefix}…` };
}
