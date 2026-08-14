// Visualizer logic — PURE (no IO). Build graph/timeline/heatmap/messages/metrics
// from VisualEvent[]. The realtime server imports this module; the client only renders results.

// ---------- graph ----------

export function buildGraph(events) {
  const nodes = [];
  const links = [];
  const root = {
    id: "root",
    kind: "session_root",
    label: "session",
    status: "idle",
    ts: events[0]?.ts || new Date().toISOString(),
    depth: 0,
    parentId: null,
  };
  nodes.push(root);

  let cur = root; // Currently open node.
  let curTurn = null;
  const toolNodeByUseId = new Map(); // toolUseId → tool_call node
  const agentNodeById = new Map(); // agentId → subagent_start node
  let seq = 0;

  const link = (source, target, kind) => {
    if (!source || !target) return;
    links.push({ source: source.id, target: target.id, kind });
  };

  for (const ev of events) {
    seq++;
    const node = toNode(ev, seq);
    if (!node) continue;
    nodes.push(node);

    switch (ev.kind) {
      case "session_start":
        link(root, node, "parent"); cur = node; break;
      case "user_prompt":
        // Each user turn is a sibling of the session, not a child of the previous turn.
        link(root, node, "turn"); cur = node; curTurn = ev.turnId || null; break;
      case "reasoning":
        link(cur, node, "parent"); cur = node; break;
      case "agent_message":
        link(cur, node, "parent"); cur = node; break;
      case "tool_call":
        link(cur, node, "tool"); cur = node;
        if (ev.toolUseId) toolNodeByUseId.set(ev.toolUseId, node);
        break;
      case "tool_output": {
        const tc = ev.toolUseId ? toolNodeByUseId.get(ev.toolUseId) : null;
        if (tc) {
          link(tc, node, "tool");
          tc.status = "completed";
          tc.durationMs = ev.durationMs ?? tc.durationMs;
          if (ev.toolName) tc.toolName = ev.toolName;
        } else {
          link(cur, node, "parent");
        }
        cur = parentOf(links, tc) || cur;
        break;
      }
      case "tool_error": {
        const tc = ev.toolUseId ? toolNodeByUseId.get(ev.toolUseId) : null;
        if (tc) {
          link(tc, node, "tool");
          tc.status = "error";
        } else {
          link(cur, node, "parent");
        }
        cur = parentOf(links, tc) || cur;
        break;
      }
      case "subagent_start":
        link(cur, node, "parent"); cur = node;
        if (ev.agentId) agentNodeById.set(ev.agentId, node);
        break;
      case "subagent_stop": {
        const s = ev.agentId ? agentNodeById.get(ev.agentId) : null;
        if (s) {
          link(s, node, "parent");
          s.status = "completed";
        } else {
          link(cur, node, "parent");
        }
        cur = parentOf(links, s) || cur;
        break;
      }
      case "session_end":
        link(cur, node, "parent"); break;
      case "notification":
        link(cur, node, "parent"); break;
    }
  }

  return { nodes, links };
}

function toNode(ev, seq) {
  const status = nodeStatus(ev);
  const label = ev.label || ev.kind;
  const base = {
    id: ev.id || `n${seq}`,
    status,
    ts: ev.ts,
    parentId: ev.parentId || null,
    durationMs: ev.durationMs,
    toolName: ev.toolName,
    detail: ev.detail,
    turnId: ev.turnId,
    agentId: ev.agentId || null,
  };
  switch (ev.kind) {
    case "session_start": return { ...base, kind: "session_root", label: "start", depth: 0 };
    case "user_prompt": return { ...base, kind: "user_prompt", label, depth: 1 };
    case "reasoning": return { ...base, kind: "reasoning", label: "🧠 reasoning", depth: 2 };
    case "agent_message": return { ...base, kind: "agent_message", label, depth: 2 };
    case "tool_call": return { ...base, kind: "tool_call", label: `🔧 ${ev.toolName || label}`, depth: 3 };
    case "tool_output": return { ...base, kind: "tool_output", label: `✓ ${ev.toolName || ""}`.trim(), depth: 3 };
    case "tool_error": return { ...base, kind: "error", label: `✗ ${ev.toolName || "error"}`, depth: 3 };
    case "subagent_start": return { ...base, kind: "subagent_start", label: `🤖 subagent ${ev.agentId || ""}`, depth: 2 };
    case "subagent_stop": return { ...base, kind: "subagent_stop", label: `◉ ${ev.agentId || "subagent"} done`, depth: 2 };
    case "session_end": return { ...base, kind: "session_end", label: "end", depth: 0 };
    case "notification": return { ...base, kind: "agent_message", label: `ⓘ ${label}`, depth: 2 };
    default: return { ...base, kind: "agent_message", label, depth: 2 };
  }
}

function nodeStatus(ev) {
  if (ev.kind === "tool_error") return "error";
  if (ev.error) return "error";
  return "completed";
}

function parentOf(links, node) {
  if (!node) return null;
  for (const l of links) if (l.target === node.id) return { id: l.source };
  return null;
}

// ---------- timeline ----------

export function buildTimeline(events) {
  const out = [];
  let open = null;
  for (const ev of events) {
    if (ev.kind === "user_prompt") {
      if (open) { open.endTs = ev.ts; out.push(open); }
      open = { id: ev.id, kind: "user_prompt", label: ev.label, startTs: ev.ts, endTs: null, durationMs: null, status: "completed", turnId: ev.turnId };
    } else if (ev.kind === "reasoning" || ev.kind === "agent_message" || ev.kind === "tool_call" || ev.kind === "subagent_start") {
      out.push({
        id: ev.id, kind: toNodeKind(ev), label: ev.label, startTs: ev.ts,
        endTs: ev.ts, durationMs: ev.durationMs ?? null, status: nodeStatus(ev), turnId: ev.turnId,
      });
    } else if (ev.kind === "session_end") {
      if (open) { open.endTs = ev.ts; open.durationMs = deltaMs(open.startTs, ev.ts); out.push(open); open = null; }
      out.push({ id: ev.id, kind: "session_end", label: "end", startTs: ev.ts, endTs: ev.ts, durationMs: null, status: "completed" });
    }
  }
  if (open) out.push(open);
  return out;
}

function toNodeKind(ev) {
  switch (ev.kind) {
    case "reasoning": return "reasoning";
    case "tool_call": return "tool_call";
    case "subagent_start": return "subagent_start";
    case "agent_message": return "agent_message";
    default: return "agent_message";
  }
}

function deltaMs(a, b) {
  const t1 = Date.parse(a), t2 = Date.parse(b);
  if (isNaN(t1) || isNaN(t2)) return null;
  return Math.max(0, t2 - t1);
}

// ---------- heatmap ----------

export function buildHeatmap(events) {
  const files = new Map();
  for (const ev of events) {
    for (const f of ev.filePaths || []) {
      const rec = files.get(f.path) || { path: f.path, read: 0, write: 0, edit: 0, bash: 0, total: 0, lastTs: "" };
      rec[f.op] = (rec[f.op] || 0) + 1;
      rec.total++;
      if (ev.ts > (rec.lastTs || "")) rec.lastTs = ev.ts;
      files.set(f.path, rec);
    }
  }
  return [...files.values()].sort((a, b) => b.total - a.total).slice(0, 80);
}

// ---------- messages ----------

export function buildMessages(events) {
  const out = [];
  for (const ev of events) {
    switch (ev.kind) {
      case "user_prompt":
        out.push({ id: ev.id, role: "user", ts: ev.ts, text: ev.detail || ev.label, turnId: ev.turnId });
        break;
      case "agent_message":
        out.push({ id: ev.id, role: "assistant", ts: ev.ts, phase: ev.phase, text: ev.detail || ev.label, turnId: ev.turnId });
        break;
      case "tool_call":
        out.push({ id: ev.id, role: "tool", ts: ev.ts, text: `→ ${ev.toolName || ev.label}`, toolName: ev.toolName, turnId: ev.turnId });
        break;
      case "tool_output":
        out.push({ id: ev.id, role: "tool", ts: ev.ts, text: ev.detail || ev.label, toolName: ev.toolName, turnId: ev.turnId });
        break;
      case "tool_error":
        out.push({ id: ev.id, role: "tool", ts: ev.ts, text: `✗ ${ev.error || ev.detail || ev.label}`, toolName: ev.toolName, turnId: ev.turnId });
        break;
      case "subagent_start":
        out.push({ id: ev.id, role: "assistant", ts: ev.ts, text: `🤖 spawn subagent ${ev.agentId || ""}`, turnId: ev.turnId });
        break;
      case "subagent_stop":
        out.push({ id: ev.id, role: "assistant", ts: ev.ts, text: `◉ subagent ${ev.agentId || ""} completed`, turnId: ev.turnId });
        break;
      default:
        break;
    }
  }
  return out;
}

// ---------- metrics ----------

export function buildMetrics(events) {
  let toolCount = 0, tokenTotal = 0, durationMs = 0, errorCount = 0;
  const fileSet = new Set();
  let firstTs = null, lastTs = null;
  for (const ev of events) {
    if (ev.kind === "tool_call") toolCount++;
    if (ev.kind === "tool_error") errorCount++;
    if (ev.tokens?.total) tokenTotal = Math.max(tokenTotal, ev.tokens.total);
    if (ev.durationMs) durationMs += ev.durationMs;
    for (const f of ev.filePaths || []) fileSet.add(f.path);
    if (!firstTs || ev.ts < firstTs) firstTs = ev.ts;
    if (!lastTs || ev.ts > lastTs) lastTs = ev.ts;
  }
  if (!durationMs && firstTs && lastTs) durationMs = deltaMs(firstTs, lastTs);
  return { toolCount, tokenTotal, durationMs, errorCount, fileCount: fileSet.size };
}

// ---------- recompute all derived data ----------

export function recompute(events) {
  return {
    graph: buildGraph(events),
    timeline: buildTimeline(events),
    heatmap: buildHeatmap(events),
    messages: buildMessages(events),
    metrics: buildMetrics(events),
  };
}
