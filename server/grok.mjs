// Grok session reader — ~/.grok/sessions/<encoded-cwd>/<session-id>/updates.jsonl
// Envelope {timestamp, method, params.update}. timestamp is unix seconds (string or number).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const GROK_HOME = process.env.GROK_HOME || path.join(os.homedir(), ".grok");

export function grokSessionsRoot() {
  return path.join(GROK_HOME, "sessions");
}

// Grok (and some Codex fields) store unix seconds as a string. ISO stays ISO.
export function toIsoTs(ts) {
  if (ts == null || ts === "") return new Date().toISOString();
  if (typeof ts === "number" && Number.isFinite(ts)) {
    const ms = ts < 1e12 ? ts * 1000 : ts;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  }
  const s = String(ts).trim();
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    const ms = n < 1e12 ? n * 1000 : n;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

export function findGrokUpdatePaths() {
  const acc = [];
  function walk(d, depth) {
    if (depth > 6) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && e.name === "updates.jsonl") acc.push(p);
    }
  }
  walk(grokSessionsRoot(), 0);
  return acc.sort();
}

export function grokSessionIdFromPath(filePath) {
  return path.basename(path.dirname(filePath));
}

export function readGrokSummary(sessionDir) {
  const fp = path.join(sessionDir, "summary.json");
  try {
    const s = JSON.parse(fs.readFileSync(fp, "utf8"));
    const info = s.info || {};
    return {
      id: info.id || path.basename(sessionDir),
      cwd: info.cwd || "",
      title: s.generated_title || s.session_summary || "",
      createdAt: s.created_at || null,
      updatedAt: s.updated_at || s.last_active_at || null,
      model: s.current_model_id || "",
    };
  } catch {
    return null;
  }
}

export function grokContentText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(grokContentText).join("");
  if (typeof content !== "object") return "";
  if (content.type === "image") return "";
  if (typeof content.text === "string") return content.text;
  if (content.content) return grokContentText(content.content);
  return "";
}

export function grokToolName(update) {
  const meta = update?._meta?.["x.ai/tool"];
  if (meta?.name) return meta.name;
  const title = update?.title;
  if (typeof title === "string" && title && !title.includes(" ")) return title;
  if (meta?.label) return meta.label;
  return title || "tool";
}

export function grokFileRefs(update) {
  const refs = [];
  const kind = update?.kind || "";
  const op = kind === "read" ? "read" : kind === "edit" ? "edit" : kind === "execute" ? "bash" : "unknown";
  for (const loc of update?.locations || []) {
    if (loc?.path) refs.push({ path: loc.path, op: op === "unknown" ? "read" : op });
  }
  const input = update?.rawInput || {};
  if (typeof input.target_file === "string") refs.push({ path: input.target_file, op: op === "unknown" ? "read" : op });
  if (typeof input.file_path === "string") refs.push({ path: input.file_path, op });
  return refs;
}

export function grokOutputText(update) {
  const fromContent = grokContentText(update?.content);
  if (fromContent) return fromContent;
  const raw = update?.rawOutput;
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object") {
    return raw.output_for_prompt || raw.FileNotFound || raw.FileTooLarge || JSON.stringify(raw);
  }
  return "";
}

export function inferRuntime(filePath) {
  const p = String(filePath || "");
  if (p.includes(`${path.sep}.codex${path.sep}`) || p.includes("/.codex/")) return "codex";
  if (p.includes(`${path.sep}.grok${path.sep}`) || p.includes("/.grok/")) return "grok";
  return "claude";
}

export { GROK_HOME };
