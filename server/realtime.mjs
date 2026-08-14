// Realtime server — hook receiver (Claude) + tail watchers (Claude + Codex) + SSE hub.
// Standalone process (port 3002) so state survives a Next dev restart.
// Zero-dependency: node:http. The browser connects directly through SSE.

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { recompute } from "./visual.mjs";
import { findRolloutPaths, readCodexRollout, readCodexRolloutFull, sessionIdFromPath } from "./codex.mjs";
import { readTranscript, redactString } from "./transcript.mjs";
import {
  findGrokUpdatePaths, grokSessionIdFromPath, readGrokSummary, toIsoTs,
  grokContentText, grokToolName, grokFileRefs, grokOutputText, inferRuntime,
} from "./grok.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const PORT = Number(process.env.REALTIME_PORT || process.env.VISUAL_PORT) || 3002;
const HOST = "127.0.0.1";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

const PROJECTS_ROOT = path.join(os.homedir(), ".claude", "projects");
const CODEX_ROOT = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");

// ---------- state ----------
const sessions = new Map(); // sessionId → VisualSession (meta + events + derived)
const offsets = new Map(); // filePath → byteOffset
const pending = new Map(); // filePath → partial line buffer
const hooks = new Map(); // claude session_id → {startedAt, lastEventAt, path, cwd}
const watched = new Set(); // filePath → explicit watch (replay)
const SSE = new Set();

// ---------- SSE ----------
function addClient(res) {
  const e = { res };
  SSE.add(e);
  res.on("close", () => SSE.delete(e));
}
function broadcast(event, payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const c of SSE) {
    try { c.res.write(`event: ${event}\n${data}`); } catch { SSE.delete(c); }
  }
}

// ---------- helpers ----------
function isRecentlyActive(mtimeMs) {
  return Date.now() - mtimeMs < 120_000;
}

function encodeCwd(cwd) {
  return "-" + String(cwd).replace(/^\/+/, "").replace(/[\/.]/g, "-");
}

function fileToId(filePath, runtime) {
  const base = path.basename(filePath).replace(/\.jsonl$/, "");
  if (runtime === "codex") return sessionIdFromPath(filePath);
  if (runtime === "grok") return grokSessionIdFromPath(filePath);
  return base; // claude: basename = session id
}

function seedSession(runtime, id, { cwd = "", filePath = "", title = "", model = "", startedAt = "" } = {}) {
  return {
    meta: {
      runtime, id, source: "live", path: filePath, cwd, title, model,
      projectDir: runtime === "codex" ? path.dirname(filePath).split(CODEX_ROOT + "/")[1] || "" : encodeCwd(cwd),
      startedAt: startedAt || new Date().toISOString(), endedAt: null,
      status: "running", mtimeMs: Date.now(), sizeBytes: 0,
    },
    events: [], graph: { nodes: [], links: [] }, timeline: [], heatmap: [], messages: [],
    metrics: { toolCount: 0, tokenTotal: 0, durationMs: 0, errorCount: 0, fileCount: 0 },
  };
}

function recomputeSession(s) {
  const d = recompute(s.events);
  s.graph = d.graph;
  s.timeline = d.timeline;
  s.heatmap = d.heatmap;
  s.messages = d.messages;
  s.metrics = d.metrics;
  return s;
}

function pushEvent(s, ev) {
  s.events.push(ev);
  // Cap at the latest 2,000 events without invalidating derived data.
  if (s.events.length > 2000) {
    s.events = s.events.slice(s.events.length - 2000).map((e, i) => ({ ...e, seq: i }));
  }
  recomputeSession(s);
  s.meta.mtimeMs = Date.now();
  s.meta.status = "running";
  s.meta.sizeBytes = s.meta.path ? safeStatSize(s.meta.path) : s.meta.sizeBytes;
  sessions.set(s.meta.id, s);
}

function safeStatSize(p) {
  try { return fs.statSync(p).size; } catch { return 0; }
}

function emitUpsert(id) {
  const s = sessions.get(id);
  if (!s) return;
  broadcast("session.upsert", { id, meta: s.meta, metrics: s.metrics, events: s.events.slice(-20) });
}

// ---------- Claude hook ingestion ----------
function ingestClaudeHook(b) {
  if (!b || !b.session_id) return;
  const sid = b.session_id;
  let s = sessions.get(sid) || seedSession("claude", sid, { cwd: b.cwd || "", filePath: b.transcript_path || "" });
  if (b.transcript_path && !s.meta.path) s.meta.path = b.transcript_path;
  if (b.cwd && !s.meta.cwd) s.meta.cwd = b.cwd;

  const ev = hookToVisualEvent(b, s.events.length, sid);
  if (!ev) return;

  hooks.set(sid, { startedAt: hooks.get(sid)?.startedAt || Date.now(), lastEventAt: Date.now(), path: b.transcript_path, cwd: b.cwd });
  if (b.transcript_path) ensureWatched(b.transcript_path, "claude");

  pushEvent(s, ev);

  if (b.hook_event_name === "SessionStart") {
    s.meta.startedAt = ev.ts;
    s.meta.source = "live";
  }
  if (b.hook_event_name === "SessionEnd") {
    s.meta.endedAt = ev.ts;
    s.meta.status = "idle";
  }
  emitUpsert(sid);
}

function hookToVisualEvent(b, seq, sid) {
  const ts = toIsoTs(new Date().toISOString());
  const base = { runtime: "claude", sessionId: sid, ts, seq, parentId: null };
  switch (b.hook_event_name) {
    case "SessionStart":
      return { ...base, kind: "session_start", id: `hs${seq}`, label: "started", agentId: b.agent_id || null };
    case "UserPromptSubmit":
      return { ...base, kind: "user_prompt", id: `hu${seq}`, turnId: b.prompt_id, label: redactString(String(b.user_prompt || "").slice(0, 140)), detail: redactString(b.user_prompt) };
    case "PreToolUse":
      return {
        ...base, kind: "tool_call", id: `ht${seq}`, turnId: b.prompt_id, toolUseId: b.tool_use_id,
        toolName: b.tool_name, label: b.tool_name, detail: redactString(JSON.stringify(b.tool_input || {}).slice(0, 600)),
        filePaths: fileRefsFromHook(b),
      };
    case "PostToolUse":
      return {
        ...base, kind: "tool_output", id: `ho${seq}`, turnId: b.prompt_id, toolUseId: b.tool_use_id,
        toolName: b.tool_name, label: `✓ ${b.tool_name}`, detail: redactString(String(b.tool_response || "").slice(0, 500)),
      };
    case "PostToolUseFailure":
      return {
        ...base, kind: "tool_error", id: `he${seq}`, turnId: b.prompt_id, toolUseId: b.tool_use_id,
        toolName: b.tool_name, label: `✗ ${b.tool_name}`, error: redactString(String(b.error || b.tool_response || "").slice(0, 300)),
      };
    case "Stop":
      return { ...base, kind: "agent_message", id: `hst${seq}`, turnId: b.prompt_id, label: redactString(String(b.last_assistant_message || "stop").slice(0, 140)), detail: redactString(b.last_assistant_message), phase: "final_answer" };
    case "SubagentStop":
      return { ...base, kind: "subagent_stop", id: `hsb${seq}`, turnId: b.prompt_id, agentId: b.agent_id, label: `subagent ${b.agent_id || ""} done` };
    case "PreCompact":
      return { ...base, kind: "notification", id: `hc${seq}`, label: "compact" };
    case "Notification":
      return { ...base, kind: "notification", id: `hn${seq}`, label: `${b.notification_type || "notif"}: ${String(b.message || "").slice(0, 140)}` };
    case "SessionEnd":
      return { ...base, kind: "session_end", id: `hsE${seq}`, label: "end" };
    default:
      return null;
  }
}

function fileRefsFromHook(b) {
  const refs = [];
  const input = b.tool_input || {};
  const name = b.tool_name || "";
  const op = /^Read/i.test(name) ? "read" : /Write|Edit|MultiEdit|NotebookEdit/i.test(name) ? "edit" : /Bash/i.test(name) ? "bash" : "unknown";
  if (typeof input.file_path === "string") refs.push({ path: input.file_path, op });
  if (Array.isArray(input.file_paths)) for (const p of input.file_paths) refs.push({ path: p, op });
  if (name === "Bash") refs.push({ path: input.cwd || "(bash)", op: "bash" });
  return refs;
}

// Codex writes the same turn twice: event_msg + response_item. It also injects
// environment/system blobs as role=user, and repeats the last reply on task_complete.
const SYNTHETIC_CODEX_TEXT = /<(environment_context|turn_aborted|skills_instructions|permissions instructions|collaboration_mode)\b/i;

function normEventText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function isSyntheticCodexText(text) {
  const t = String(text || "").trim();
  return !t || SYNTHETIC_CODEX_TEXT.test(t);
}

function hasSimilarEvent(s, kind, turnId, text) {
  const needle = normEventText(text);
  if (!needle) return true;
  return s.events.some((e) =>
    e.kind === kind &&
    (!turnId || e.turnId === turnId) &&
    normEventText(e.detail || e.label) === needle
  );
}

function pushCodexMessage(s, ev) {
  if (isSyntheticCodexText(ev.detail || ev.label)) return;
  if (hasSimilarEvent(s, ev.kind, ev.turnId, ev.detail || ev.label)) return;
  pushEvent(s, ev);
}

function codexErrorMessage(err) {
  if (!err) return "";
  if (typeof err === "string") return err;
  return err.message || err.codex_error_info || JSON.stringify(err);
}

// ---------- Codex ingestion ----------
function ingestCodexLine(obj, filePath, seq) {
  const sid = sessionIdFromPath(filePath);
  let s = sessions.get(sid) || seedSession("codex", sid, { filePath });
  const ts = toIsoTs(obj.timestamp);
  const base = { runtime: "codex", sessionId: sid, ts, seq, parentId: null };

  if (obj.type === "session_meta") {
    const p = obj.payload || {};
    s.meta.cwd = p.cwd || s.meta.cwd;
    s.meta.startedAt = p.timestamp || ts;
    s.meta.cliVersion = p.cli_version;
    s.meta.model = p.model_provider;
    pushEvent(s, { ...base, kind: "session_start", id: `cs${seq}`, label: "started" });
    return s;
  }

  if (obj.type === "turn_context") {
    const turnId = obj.payload?.turn_id;
    if (turnId) s._curTurn = turnId;
    return s;
  }

  const turnId = obj.payload?.internal_chat_message_metadata_passthrough?.turn_id || s._curTurn;

  if (obj.type === "event_msg") {
    const p = obj.payload || {};
    switch (p.type) {
      case "task_started":
        // Lifecycle only — the real turn starts at the user prompt.
        s._curTurn = p.turn_id || s._curTurn;
        break;
      case "user_message":
        pushCodexMessage(s, { ...base, kind: "user_prompt", id: `cum${seq}`, turnId: s._curTurn, label: String(p.message || "").slice(0, 140), detail: p.message });
        break;
      case "agent_message":
        pushCodexMessage(s, { ...base, kind: "agent_message", id: `cam${seq}`, turnId: s._curTurn, label: String(p.message || "").slice(0, 140), detail: p.message, phase: p.phase === "final_answer" ? "final_answer" : "commentary" });
        break;
      case "token_count": {
        const u = p.info?.total_token_usage || {};
        const last = s.events[s.events.length - 1];
        if (last) last.tokens = {
          input: u.input_tokens || 0, output: u.output_tokens || 0,
          reasoning: u.reasoning_output_tokens, cacheRead: u.cached_input_tokens,
          total: u.total_tokens || (u.input_tokens || 0) + (u.output_tokens || 0),
        };
        recomputeSession(s);
        break;
      }
      case "turn_aborted":
        pushEvent(s, { ...base, kind: "agent_message", id: `cta${seq}`, turnId: p.turn_id, label: `⏹ turn aborted · ${p.reason || ""}`, detail: `duration ${Math.round((p.duration_ms || 0) / 1000)}s`, phase: "final_answer" });
        break;
      case "task_complete": {
        const errMsg = codexErrorMessage(p.error);
        if (errMsg) {
          const code = (typeof p.error === "object" && p.error?.codex_error_info) || "turn";
          pushEvent(s, {
            ...base, kind: "tool_error", id: `cte${seq}`, turnId: p.turn_id,
            toolName: code, label: errMsg.slice(0, 140), detail: errMsg, error: errMsg,
          });
          break;
        }
        // The last assistant response_item already carries this text.
        if (p.last_agent_message) {
          pushCodexMessage(s, { ...base, kind: "agent_message", id: `ctc${seq}`, turnId: p.turn_id, label: String(p.last_agent_message).slice(0, 140), detail: p.last_agent_message, phase: "final_answer" });
        }
        break;
      }
      default: break; // thread_settings_applied → skip
    }
    return s;
  }

  if (obj.type === "response_item") {
    const p = obj.payload || {};
    switch (p.type) {
      case "reasoning": {
        const encLen = p.encrypted_content ? p.encrypted_content.length : 0;
        pushEvent(s, { ...base, kind: "reasoning", id: `cr${seq}`, turnId: turnId, label: "🧠 reasoning", detail: `(encrypted · ${encLen} bytes)` });
        break;
      }
      case "message": {
        if (p.role === "developer") break; // system blob — skip
        const text = Array.isArray(p.content) ? p.content.filter((c) => c?.text).map((c) => c.text).join("\n") : "";
        if (!text) break;
        if (p.role === "user") {
          pushCodexMessage(s, { ...base, kind: "user_prompt", id: `cm${seq}`, turnId: turnId, label: text.slice(0, 140), detail: text });
        } else {
          pushCodexMessage(s, { ...base, kind: "agent_message", id: `cm${seq}`, turnId: turnId, label: text.slice(0, 140), detail: text, phase: p.phase === "final_answer" ? "final_answer" : "commentary" });
        }
        break;
      }
      case "function_call": {
        let input;
        try { input = JSON.parse(p.arguments || "{}"); } catch { input = p.arguments; }
        pushEvent(s, {
          ...base, kind: "tool_call", id: `cf${seq}`, turnId: turnId, toolUseId: p.call_id,
          toolName: p.name, label: p.name, detail: typeof input === "string" ? input.slice(0, 600) : JSON.stringify(input).slice(0, 600),
          filePaths: codexFileRefs(p.name, input),
        });
        break;
      }
      case "function_call_output": {
        const out = String(p.output || "");
        const isErr = /process exited with code [1-9]/i.test(out);
        pushEvent(s, {
          ...base, kind: isErr ? "tool_error" : "tool_output", id: `cfo${seq}`, turnId: turnId,
          toolUseId: p.call_id, label: isErr ? "✗" : "✓", detail: out.slice(0, 500), error: isErr ? out.slice(0, 300) : undefined,
        });
        break;
      }
      default: break;
    }
    return s;
  }

  return s;
}

function codexFileRefs(name, input) {
  const refs = [];
  if (name === "exec_command" && input?.cmd) refs.push({ path: input.workdir || "(bash)", op: "bash" });
  if (input?.file_path) refs.push({ path: input.file_path, op: "write" });
  return refs;
}

function seedGrokSession(filePath) {
  const sid = grokSessionIdFromPath(filePath);
  const existing = sessions.get(sid);
  if (existing) return existing;
  const summary = readGrokSummary(path.dirname(filePath));
  const s = seedSession("grok", sid, {
    filePath,
    cwd: summary?.cwd || "",
    title: summary?.title || "",
    model: summary?.model || "",
    startedAt: summary?.createdAt ? toIsoTs(summary.createdAt) : "",
  });
  return s;
}

function appendGrokChunk(s, ev) {
  const last = s.events[s.events.length - 1];
  const samePrompt = ev._promptIndex == null || last?._promptIndex === ev._promptIndex;
  if (last && last.kind === ev.kind && last._chunk && samePrompt) {
    last.detail = `${last.detail || ""}${ev.detail || ""}`;
    last.label = String(last.detail).slice(0, 140);
    last.ts = ev.ts;
    recomputeSession(s);
    s.meta.mtimeMs = Date.now();
    return;
  }
  pushEvent(s, ev);
}

function ingestGrokLine(obj, filePath, seq) {
  const sid = grokSessionIdFromPath(filePath);
  let s = sessions.get(sid) || seedGrokSession(filePath);
  const ts = toIsoTs(obj.timestamp);
  const base = { runtime: "grok", sessionId: sid, ts, seq, parentId: null };
  const update = obj.params?.update;
  if (!update || typeof update !== "object") return s;

  const kind = update.sessionUpdate;
  switch (kind) {
    case "hook_execution":
      if (update.event_name === "session_start" && !s.events.some((e) => e.kind === "session_start")) {
        pushEvent(s, { ...base, kind: "session_start", id: `gs${seq}`, label: "started" });
      }
      break;
    case "user_message_chunk": {
      const text = grokContentText(update.content);
      if (!text) break;
      appendGrokChunk(s, {
        ...base, kind: "user_prompt", id: `gu${seq}`,
        label: text.slice(0, 140), detail: text, _chunk: true,
        _promptIndex: update._meta?.promptIndex,
        turnId: update._meta?.promptIndex != null ? `p${update._meta.promptIndex}` : undefined,
      });
      break;
    }
    case "agent_thought_chunk": {
      const text = grokContentText(update.content);
      if (!text) break;
      appendGrokChunk(s, { ...base, kind: "reasoning", id: `gth${seq}`, label: "🧠 reasoning", detail: text, _chunk: true });
      break;
    }
    case "agent_message_chunk": {
      const text = grokContentText(update.content);
      if (!text) break;
      appendGrokChunk(s, { ...base, kind: "agent_message", id: `ga${seq}`, label: text.slice(0, 140), detail: text, _chunk: true });
      break;
    }
    case "tool_call": {
      const name = grokToolName(update);
      const isSub = /^(spawn_subagent|subagent)$/i.test(name);
      pushEvent(s, {
        ...base,
        kind: isSub ? "subagent_start" : "tool_call",
        id: `gt${seq}`,
        toolUseId: update.toolCallId,
        toolName: name,
        agentId: isSub ? update.toolCallId : undefined,
        label: name,
        detail: JSON.stringify(update.rawInput || {}).slice(0, 600),
        filePaths: grokFileRefs(update),
      });
      break;
    }
    case "tool_call_update": {
      if (update.status !== "completed" && update.status !== "failed") {
        const existing = update.toolCallId
          ? s.events.find((e) => e.toolUseId === update.toolCallId && e.kind === "tool_call")
          : null;
        if (existing) {
          const refs = grokFileRefs(update);
          if (refs.length) existing.filePaths = [...(existing.filePaths || []), ...refs];
          if (update.title && !existing.detail) existing.detail = update.title;
        }
        break;
      }
      const text = grokOutputText(update);
      const failed = update.status === "failed";
      pushEvent(s, {
        ...base,
        kind: failed ? "tool_error" : "tool_output",
        id: `go${seq}`,
        toolUseId: update.toolCallId,
        toolName: grokToolName(update),
        label: failed ? "✗" : "✓",
        detail: String(text).slice(0, 500),
        error: failed ? String(text).slice(0, 300) : undefined,
      });
      break;
    }
    case "turn_completed": {
      const u = update.usage || {};
      if (u.totalTokens || u.inputTokens) {
        const last = s.events[s.events.length - 1];
        if (last) last.tokens = {
          input: u.inputTokens || 0,
          output: u.outputTokens || 0,
          reasoning: u.reasoningTokens,
          cacheRead: u.cachedReadTokens,
          total: u.totalTokens || (u.inputTokens || 0) + (u.outputTokens || 0),
        };
        recomputeSession(s);
      }
      break;
    }
    default:
      break;
  }
  return s;
}

// ---------- tail watcher ----------
const TAIL_MS = 800;
let watcherTimer = null;

function ensureWatched(filePath, runtime) {
  watched.add(JSON.stringify({ filePath, runtime }));
  startWatcher();
}

function startWatcher() {
  if (watcherTimer) return;
  watcherTimer = setInterval(tailTick, TAIL_MS);
  watcherTimer.unref?.();
}

function tailTick() {
  // 1) Scan Claude directories for new or growing files.
  try {
    const dirs = fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true });
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const dirPath = path.join(PROJECTS_ROOT, d.name);
      let files;
      try { files = fs.readdirSync(dirPath); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith(".jsonl")) continue;
        const fp = path.join(dirPath, f);
        tailFile(fp, "claude");
      }
    }
  } catch { /* projects root missing */ }

  // 2) Codex rollouts
  for (const fp of findRolloutPaths()) tailFile(fp, "codex");

  // 3) Grok sessions (updates.jsonl)
  for (const fp of findGrokUpdatePaths()) tailFile(fp, "grok");
}

function tailFile(filePath, runtime) {
  const key = JSON.stringify({ filePath, runtime });
  const isExplicit = watched.has(key);
  let st;
  try { st = fs.statSync(filePath); } catch { return; } // File disappeared.

  const id = fileToId(filePath, runtime);
  const off = offsets.get(filePath) ?? 0;
  if (st.size < off) { offsets.set(filePath, 0); return; } // truncated
  if (st.size === off) {
    // idle detect
    const s = sessions.get(id);
    if (s && s.meta.runtime === runtime && s.meta.status === "running" && !isExplicit && Date.now() - st.mtimeMs > 30_000) {
      s.meta.status = "idle";
      if (runtime === "codex") {
        // Add a synthetic session_end if one is missing.
        const hasEnd = s.events.some((e) => e.kind === "session_end");
        if (!hasEnd) {
          pushEvent(s, { runtime, sessionId: id, kind: "session_end", id: `end${s.events.length}`, seq: s.events.length, ts: new Date().toISOString(), label: "end", parentId: null });
          s.meta.endedAt = new Date().toISOString();
          s.meta.status = "idle";
        }
      }
      emitUpsert(id);
    }
    return;
  }

  const fd = fs.openSync(filePath, "r");
  const buf = Buffer.alloc(st.size - off);
  fs.readSync(fd, buf, 0, buf.length, off);
  fs.closeSync(fd);

  let partial = pending.get(filePath) || "";
  const text = partial + buf.toString("utf8");
  const lines = text.split("\n");
  pending.set(filePath, lines.pop() || "");
  offsets.set(filePath, st.size);

  let s = sessions.get(id);
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; } // partial mid-write
    if (runtime === "codex") {
      s = ingestCodexLine(obj, filePath, s ? s.events.length : 0) || s;
    } else if (runtime === "grok") {
      s = ingestGrokLine(obj, filePath, s ? s.events.length : 0) || s;
    } else {
      s = ingestClaudeLine(obj, filePath, s ? s.events.length : 0, id) || s;
    }
  }
  if (s) {
    s.meta.mtimeMs = st.mtimeMs;
    s.meta.sizeBytes = st.size;
    s.meta.status = isRecentlyActive(st.mtimeMs) || s.meta.status === "error" ? "running" : "idle";
    const firstTs = s.events[0]?.ts;
    if (firstTs && (!s.meta.startedAt || s.meta.startedAt > firstTs)) s.meta.startedAt = firstTs;
    sessions.set(id, s);
    emitUpsert(id);
  }
}

// Claude tail — parse new transcript lines into VisualEvents (simpler than hooks).
function ingestClaudeLine(obj, filePath, seq, sid) {
  let s = sessions.get(sid) || seedSession("claude", sid, { filePath });
  if (obj.cwd && !s.meta.cwd) s.meta.cwd = obj.cwd;
  const ts = toIsoTs(obj.timestamp);
  const base = { runtime: "claude", sessionId: sid, ts, seq, parentId: obj.parentUuid || null };
  let ev = null;

  if (obj.type === "user" && obj.promptSource === "typed" && !obj.isMeta && typeof obj.message?.content === "string") {
    ev = { ...base, kind: "user_prompt", id: `tu${seq}`, turnId: obj.promptId || obj.uuid, label: obj.message.content.slice(0, 140), detail: obj.message.content };
  } else if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
    for (const b of obj.message.content) {
      if (b?.type === "thinking") ev = { ...base, kind: "reasoning", id: `tth${seq}`, turnId: obj.parentUuid, label: "🧠 reasoning", detail: String(b.thinking || "").slice(0, 500) };
      else if (b?.type === "text" && b.text) ev = { ...base, kind: "agent_message", id: `tas${seq}`, turnId: obj.parentUuid, label: b.text.slice(0, 140), detail: b.text };
      else if (b?.type === "tool_use") ev = { ...base, kind: "tool_call", id: `ttc${seq}`, turnId: obj.parentUuid, toolUseId: b.id, toolName: b.name, label: b.name, detail: JSON.stringify(b.input || {}).slice(0, 500) };
    }
  } else if (obj.type === "user" && Array.isArray(obj.message?.content)) {
    for (const b of obj.message.content) {
      if (b?.type === "tool_result") {
        const txt = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map((c) => c?.text || "").join("\n") : "";
        ev = { ...base, kind: b.is_error ? "tool_error" : "tool_output", id: `ttr${seq}`, turnId: obj.parentUuid, toolUseId: b.tool_use_id, label: b.is_error ? "✗" : "✓", detail: txt.slice(0, 500), error: b.is_error ? txt.slice(0, 300) : undefined };
      }
    }
  } else if (obj.type === "system" && obj.subtype === "turn_duration") {
    return s; // Auxiliary metrics are skipped for faster tailing.
  }

  if (ev) pushEvent(s, ev);
  return s;
}

// ---------- HTTP ----------
function sendJson(res, code, obj) {
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Private-Network": "true",
  });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Private-Network": "true",
    });
    return res.end();
  }

  try {
    if (p === "/api/v1/health") {
      return sendJson(res, 200, { ok: true, port: PORT, sessions: sessions.size });
    }

    if (p === "/api/v1/hooks" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => { body += c; if (body.length > 1_000_000) req.destroy(); });
      req.on("end", () => {
        try {
          const b = JSON.parse(body || "{}");
          ingestClaudeHook(b);
        } catch { /* Invalid hook body still returns 202 and does not block Claude. */ }
        // Reply with 202 immediately so Claude is not delayed.
        res.writeHead(202, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end("{}");
      });
      return;
    }

    if (p === "/api/v1/sessions" && req.method === "GET") {
      const out = [...sessions.values()]
        .map((s) => ({ meta: s.meta, metrics: s.metrics }))
        .sort((a, b) => (b.meta?.mtimeMs || 0) - (a.meta?.mtimeMs || 0));
      return sendJson(res, 200, { sessions: out });
    }

    if (p.startsWith("/api/v1/sessions/")) {
      const id = decodeURIComponent(p.slice("/api/v1/sessions/".length));
      const s = sessions.get(id);
      if (!s) return sendJson(res, 404, { error: "not found" });
      // Cap events sent to avoid oversized payloads.
      const sCopy = { ...s, events: s.events.slice(-2000) };
      return sendJson(res, 200, { session: sCopy });
    }

    if (p === "/api/v1/watch" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        try {
          const b = JSON.parse(body || "{}");
          const filePath = b.path;
          const runtime = b.runtime || inferRuntime(filePath);
          ensureWatched(filePath, runtime);
            // Parse the complete file immediately for replay.
          if (runtime === "codex") {
            const { events, size } = readCodexRolloutFull(filePath);
            const sid = sessionIdFromPath(filePath);
            let s = sessions.get(sid) || seedSession("codex", sid, { filePath });
            for (const ev of events) s = ingestCodexLine(ev, filePath, s ? s.events.length : 0) || s;
            s.meta.sizeBytes = size;
            s.meta.source = "file";
            sessions.set(sid, s);
            emitUpsert(sid);
            return sendJson(res, 200, { ok: true, id: sid });
          } else if (runtime === "grok") {
            const { events, size } = readCodexRolloutFull(filePath);
            const sid = grokSessionIdFromPath(filePath);
            let s = sessions.get(sid) || seedGrokSession(filePath);
            for (const ev of events) s = ingestGrokLine(ev, filePath, s ? s.events.length : 0) || s;
            s.meta.sizeBytes = size;
            s.meta.source = "file";
            sessions.set(sid, s);
            emitUpsert(sid);
            return sendJson(res, 200, { ok: true, id: sid });
          } else {
            // Claude replay — read the complete file through the store or raw parser.
            const r = readTranscript(filePath);
            const sid = path.basename(filePath).replace(/\.jsonl$/, "");
            let s = sessions.get(sid) || seedSession("claude", sid, { filePath });
            if (r.ok) {
              for (const ev of r.events) s = ingestClaudeLine(ev, filePath, s ? s.events.length : 0, sid) || s;
            }
            s.meta.source = "file";
            s.meta.sizeBytes = r.sizeBytes ?? 0;
            sessions.set(sid, s);
            emitUpsert(sid);
            return sendJson(res, 200, { ok: true, id: sid });
          }
        } catch (err) {
          return sendJson(res, 500, { error: String(err) });
        }
      });
      return;
    }

    if (p === "/api/v1/stream") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Private-Network": "true",
        "X-Accel-Buffering": "no",
      });
      res.write("retry: 1000\n\n");
      res.write(`event: health\ndata: {"ok":true}\n\n`);
      addClient(res);
      req.on("close", () => SSE.delete({ res }));
      return;
    }

    // ---- static dashboard (public/) ----
    if (req.method === "GET" && !p.startsWith("/api/")) {
      const rel = p === "/" ? "index.html" : p.replace(/^\/+/, "");
      const fp = path.resolve(PUBLIC_DIR, rel);
      if (fp.startsWith(PUBLIC_DIR) && fs.existsSync(fp) && !fs.statSync(fp).isDirectory()) {
        return sendFile(res, fp);
      }
      return sendFile(res, path.join(PUBLIC_DIR, "index.html"));
    }

    sendJson(res, 404, { error: "not found" });
  } catch (err) {
    sendJson(res, 500, { error: String(err) });
  }
});

// ---------- static file serving (public/) ----------
function sendFile(res, filePath) {
  const ext = path.extname(filePath);
  let body;
  try {
    body = fs.readFileSync(filePath);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
    return;
  }
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": "no-cache" });
  res.end(body);
}

server.listen(PORT, HOST, () => {
  console.log(`Realtime Agent Visualizer → http://${HOST}:${PORT}`);
  console.log(`Claude projects: ${PROJECTS_ROOT}`);
  console.log(`Codex sessions: ${CODEX_ROOT}`);
  console.log(`Grok sessions: ${path.join(os.homedir(), ".grok", "sessions")}`);
  startWatcher();
});

process.on("SIGINT", () => {
  for (const c of SSE) c.res.end();
  process.exit(0);
});
