// Codex rollout reader — list sessions, incremental tail read, full parse.
// Format verified: ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
// Envelope {timestamp, type, payload}. event_msg/response_item carry payload.type.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");

export function codexSessionsRoot() {
  return path.join(CODEX_HOME, "sessions");
}

export function findRolloutPaths() {
  const acc = [];
  function walk(d) {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) acc.push(p);
    }
  }
  walk(codexSessionsRoot());
  return acc.sort();
}

// history.jsonl = {session_id, ts (epoch s), text} — prompt history for quick session listing.
export function readHistory() {
  const out = new Map(); // session_id → {ts, text}
  const hp = path.join(CODEX_HOME, "history.jsonl");
  try {
    for (const line of fs.readFileSync(hp, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o?.session_id) out.set(o.session_id, { ts: o.ts, text: o.text });
      } catch { /* skip */ }
    }
  } catch { /* History file is optional. */ }
  return out;
}

export function listCodexSessions() {
  const hist = readHistory();
  const out = [];
  for (const p of findRolloutPaths()) {
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    const fname = path.basename(p).replace(/^rollout-/, "").replace(/\.jsonl$/, "");
    const uuid = fname.split("-").slice(1).join("-"); // The remaining part is the session UUID.
    const id = uuid || fname;
    const h = hist.get(id);
    out.push({
      id,
      path: p,
      sizeBytes: st.size,
      mtimeMs: st.mtimeMs,
      startedAt: h ? new Date(h.ts * 1000).toISOString() : null,
      lastPrompt: h?.text || null,
    });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

// Read incrementally from an offset and return complete events, the next offset, and a partial line.
export function readCodexRollout(filePath, offset = 0) {
  let st;
  try { st = fs.statSync(filePath); } catch { return { events: [], nextOffset: offset, partial: "", size: 0 }; }
  if (st.size < offset) return { events: [], nextOffset: 0, partial: "", size: st.size }; // truncated
  if (st.size === offset) return { events: [], nextOffset: offset, partial: "", size: st.size };

  const fd = fs.openSync(filePath, "r");
  const buf = Buffer.alloc(st.size - offset);
  fs.readSync(fd, buf, 0, buf.length, offset);
  fs.closeSync(fd);

  const text = buf.toString("utf8");
  const lines = text.split("\n");
  const partial = lines.pop() || "";
  const events = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* partial/broken — skip */ }
  }
  return { events, nextOffset: st.size, partial, size: st.size };
}

// Read the complete file for replay and parse every line.
export function readCodexRolloutFull(filePath) {
  let st;
  try { st = fs.statSync(filePath); } catch { return { events: [], size: 0 }; }
  const text = fs.readFileSync(filePath, "utf8");
  const events = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return { events, size: st.size };
}

export function sessionIdFromPath(p) {
  const fname = path.basename(p).replace(/^rollout-/, "").replace(/\.jsonl$/, "");
  return fname.split("-").slice(1).join("-") || fname;
}

export { CODEX_HOME };
