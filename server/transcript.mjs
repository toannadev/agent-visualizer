// Parse a Claude Code transcript JSONL file (one event per line) into normalized events.
// Read-only: never modify anything under ~/.claude.

import fs from "node:fs";

// Redact API keys and tokens if they appear in content as a precaution.
// Claude Code does not write full secrets to transcripts, but prompts may contain them.
export function redactText(text) {
  if (!text || typeof text !== "string") return text;
  return text
    .replace(/(sk-ant-[A-Za-z0-9_-]{6,})/g, "sk-ant-****")
    .replace(/(sk-[A-Za-z0-9]{16,})/g, "sk-****")
    .replace(/(ghp_[A-Za-z0-9]{16,})/g, "ghp_****")
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{12,}/gi, "$1****")
    .replace(/(api[_-]?key["']?\s*[:=]\s*["']?)[A-Za-z0-9._-]{12,}/gi, "$1****");
}

const REDACTED_PATTERNS = {
  "sk-ant-": "sk-ant-****",
  "sk-": "sk-****",
  ghp_: "ghp_****",
  xoxb: "xoxb-****",
  AKIA: "AKIA****",
};

export function redactString(s) {
  if (typeof s !== "string") return s;
  let out = s;
  for (const [prefix, segact] of Object.entries(REDACTED_PATTERNS)) {
    if (out.includes(prefix)) out = out.replace(new RegExp(prefix + "[A-Za-z0-9_.-]{6,}", "g"), segact);
  }
  return out;
}

// Recursively redact objects because tool input/output may contain secret-bearing commands.
export function redactDeep(value) {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v);
    return out;
  }
  return value;
}

// ---------- helpers ----------

function extractUserText(content) {
  // Content may be a string or an array [{type:"text"...}, {type:"tool_result"...}, ...].
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = content
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text);
  return parts.join("\n");
}

function isHumanPrompt(ev) {
  return (
    ev.type === "user" &&
    !ev.isMeta &&
    ev.promptSource === "typed" &&
    ev.origin?.kind === "human" &&
    typeof ev.message?.content !== "undefined"
  );
}

function isToolResultUser(ev) {
  return (
    ev.type === "user" &&
    Array.isArray(ev.message?.content) &&
    ev.message.content.some((b) => b?.type === "tool_result")
  );
}

function extractToolUse(ev) {
  if (ev.type !== "assistant") return [];
  const content = ev.message?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((b) => b?.type === "tool_use");
}

function extractToolResults(ev) {
  if (ev.type !== "user") return [];
  const content = ev.message?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((b) => b?.type === "tool_result");
}

function extractAssistantText(ev) {
  if (ev.type !== "assistant") return "";
  const content = ev.message?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

function extractThinking(ev) {
  if (ev.type !== "assistant") return null;
  const content = ev.message?.content;
  if (!Array.isArray(content)) return null;
  return content.filter((b) => b?.type === "thinking").length;
}

// ---------- main ----------

// Read one transcript file → { events, projectDir, sessionId, errors, sizeBytes, path }.
export function readTranscript(filePath) {
  let text;
  let stat;
  try {
    stat = fs.statSync(filePath);
    text = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    return { ok: false, error: err.message };
  }

  const events = [];
  let projectDir = null;
  let sessionId = null;
  let parsed = 0;
  let skipped = 0;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev;
    try {
      ev = JSON.parse(trimmed);
      parsed++;
    } catch {
      skipped++;
      continue;
    }
    if (!ev || typeof ev !== "object") {
      skipped++;
      continue;
    }
    if (ev.cwd && !projectDir) projectDir = ev.cwd;
    if (ev.sessionId && !sessionId) sessionId = ev.sessionId;
    events.push(ev);
  }

  return {
    ok: true,
    events,
    projectDir,
    sessionId: sessionId || null,
    filePath,
    sizeBytes: stat.size,
    mtimeMs: stat.mtimeMs,
    parsed,
    skipped,
  };
}

// Convert raw events to normalized events, removing metadata noise and pairing tool results.
export function normalizeEvents(rawEvents) {
  const out = [];
  for (const ev of rawEvents) {
    if (!ev || typeof ev !== "object") continue;
    const base = { type: ev.type, timestamp: ev.timestamp ?? null, uuid: ev.uuid ?? null };

    if (ev.type === "user") {
      if (isHumanPrompt(ev)) {
        const text = redactText(extractUserText(ev.message?.content)).trim();
        out.push({
          ...base,
          kind: "user-prompt",
          text,
          promptId: ev.promptId,
          promptSource: ev.promptSource,
          isMeta: false,
          parentUuid: ev.parentUuid ?? null,
          cwd: ev.cwd ?? null,
        });
      } else if (isToolResultUser(ev)) {
        const results = extractToolResults(ev).map((b) => ({
          toolUseId: b.tool_use_id,
          isError: !!b.is_error,
          contentText: redactText(
            typeof b.content === "string"
              ? b.content
              : Array.isArray(b.content)
                ? b.content.map((c) => c?.text ?? c?.content ?? "").join("\n")
                : "",
          ),
        }));
        out.push({ ...base, kind: "tool-result", results, parentUuid: ev.parentUuid ?? null });
        // Tool results may mention files, but file references come from tool_use; skip them here.
      }
      // Ignore other user events (isMeta caveats, attachments, /model output).
    } else if (ev.type === "assistant") {
      const toolUse = extractToolUse(ev);
      const text = redactText(extractAssistantText(ev)).trim();
      const thinkingCount = extractThinking(ev);
      out.push({
        ...base,
        kind: "assistant",
        text,
        thinkingCount,
        toolUses: toolUse.map((t) => ({
          id: t.id,
          name: t.name,
          input: redactDeep(t.input ?? null),
          caller: t.caller ?? null,
        })),
        usage: ev.message?.usage ?? null,
        isApiError: !!ev.isApiErrorMessage,
        apiErrorStatus: ev.apiErrorStatus ?? null,
        error: ev.error ?? null,
        parentUuid: ev.parentUuid ?? null,
      });
    } else if (ev.type === "system" && ev.subtype === "turn_duration") {
      out.push({
        ...base,
        kind: "turn-duration",
        durationMs: ev.durationMs ?? null,
        messageCount: ev.messageCount ?? null,
        parentUuid: ev.parentUuid ?? null,
      });
    }
    // Ignore mode/permission-mode/attachment/last-prompt/ai-title/file-history-snapshot metadata.
  }
  return out;
}
