// Optional Herdr snapshot — join Claude/Grok/Codex transcripts that share a pane tab.
// Fail closed: missing binary, timeout, or bad JSON never throws.

import { spawnSync } from "node:child_process";
import path from "node:path";

const HERDR_BIN = process.env.HERDR_BIN || "herdr";
const SNAPSHOT_TTL_MS = 3_000;
const MISS_TTL_MS = 30_000;

let cache = { at: 0, ok: false, agents: [], missing: false };

export function readHerdrSnapshot() {
  const ttl = cache.missing ? MISS_TTL_MS : SNAPSHOT_TTL_MS;
  if (Date.now() - cache.at < ttl) return { ok: cache.ok, agents: cache.agents };
  const snap = spawnHerdrList();
  cache = { at: Date.now(), ok: snap.ok, agents: snap.agents, missing: snap.missing };
  return { ok: cache.ok, agents: cache.agents };
}

function spawnHerdrList() {
  const snap = spawnHerdrJson(["api", "snapshot"]);
  if (snap.missing) return snap;
  if (snap.ok) {
    const agents = agentsFromSnapshot(snap.json);
    if (agents) return { ok: true, agents, missing: false };
  }
  const list = spawnHerdrJson(["agent", "list"]);
  if (!list.ok) return list;
  const raw = list.json?.result?.agents || list.json?.agents || [];
  if (!Array.isArray(raw)) return { ok: false, agents: [], missing: false };
  return { ok: true, agents: raw.map(normalizeAgent).filter(Boolean), missing: false };
}

function spawnHerdrJson(args) {
  try {
    const r = spawnSync(HERDR_BIN, args, {
      encoding: "utf8",
      timeout: 1500,
      maxBuffer: 4_000_000,
    });
    if (r.error?.code === "ENOENT") return { ok: false, agents: [], missing: true, json: null };
    if (r.error || r.status !== 0) return { ok: false, agents: [], missing: false, json: null };
    return { ok: true, missing: false, json: JSON.parse(r.stdout || "") };
  } catch {
    return { ok: false, agents: [], missing: false, json: null };
  }
}

function agentsFromSnapshot(json) {
  const snap = json?.result?.snapshot || json?.snapshot || json?.result || json;
  const agents = snap?.agents;
  if (!Array.isArray(agents)) return null;
  const panes = Array.isArray(snap?.panes) ? snap.panes : [];
  const tokensByPane = new Map();
  for (const pane of panes) {
    if (pane?.pane_id && pane.tokens) tokensByPane.set(pane.pane_id, pane.tokens);
  }
  const workspaces = new Map();
  for (const w of Array.isArray(snap.workspaces) ? snap.workspaces : []) {
    if (w?.workspace_id) workspaces.set(w.workspace_id, w);
  }
  const tabs = new Map();
  for (const t of Array.isArray(snap.tabs) ? snap.tabs : []) {
    if (t?.tab_id) tabs.set(t.tab_id, t);
  }
  return agents.map((raw) => {
    const tokens = raw.tokens || tokensByPane.get(raw.pane_id) || null;
    const ws = workspaces.get(raw.workspace_id);
    const tab = tabs.get(raw.tab_id);
    return normalizeAgent({
      ...raw,
      tokens,
      workspace_label: ws?.label,
      workspace_number: ws?.number,
      tab_number: tab?.number,
      tab_label: tab?.label,
    });
  }).filter(Boolean);
}

function normalizeAgent(raw) {
  if (!raw || typeof raw !== "object") return null;
  const kind = String(raw.agent || raw.kind || "").toLowerCase();
  if (!kind) return null;
  const sessionId = raw.agent_session?.value || raw.agentSession?.value || null;
  const cwd = raw.cwd || raw.foreground_cwd || "";
  return {
    kind,
    name: raw.name || "",
    paneId: raw.pane_id || raw.paneId || "",
    tabId: raw.tab_id || raw.tabId || "",
    tabNumber: raw.tab_number ?? raw.tabNumber ?? null,
    tabLabel: raw.tab_label || raw.tabLabel || "",
    workspaceId: raw.workspace_id || raw.workspaceId || "",
    workspaceLabel: raw.workspace_label || raw.workspaceLabel || "",
    workspaceNumber: raw.workspace_number ?? raw.workspaceNumber ?? null,
    cwd,
    sessionId,
    status: raw.agent_status || raw.status || "",
    hodRole: extractHodRole(raw),
    hodRun: tokenStr(raw, "hod_run"),
    hodTask: tokenStr(raw, "hod_task"),
    hodParent: tokenStr(raw, "hod_parent"),
  };
}

function tokenMap(raw) {
  return raw?.tokens || raw?.orchestration || {};
}

function tokenStr(raw, name) {
  const v = tokenMap(raw)[name];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function extractHodRole(raw) {
  const fromToken = tokenMap(raw).hod_role || tokenMap(raw).role;
  if (fromToken) return String(fromToken).trim().toLowerCase();
  const blob = `${raw.name || ""} ${raw.terminal_title_stripped || raw.terminal_title || ""}`;
  if (/\b(advisor|consult)\b/i.test(blob)) return "advisor";
  if (/\b(reviewer|review)\b/i.test(blob)) return "reviewer";
  if (/\b(tester|qa)\b/i.test(blob)) return "tester";
  if (/\b(controller|lead)\b/i.test(blob)) return "controller";
  if (/\b(worker|impl|coder)\b/i.test(blob)) return "worker";
  return null;
}

function familyId(agent, byPane) {
  // Controller panes are often untagged. A child may have hod_run while the
  // parent does not — still one team. Share run/tab across the parent tree
  // and anyone on the same tab. Never fall back to workspace.
  const members = familyMembers(agent, byPane);
  const run = members.map((a) => a.hodRun).find(Boolean);
  if (run) return `run:${run}`;
  const tab = members.map((a) => a.tabId).find(Boolean) || agent.tabId;
  if (tab) return `tab:${tab}`;
  return "";
}

function familyMembers(agent, byPane) {
  if (!byPane || byPane.size === 0) return [agent];
  const root = rootAgent(agent, byPane);
  const rootPane = root?.paneId || agent.paneId;
  const tab = root?.tabId || agent.tabId;
  const out = [];
  for (const a of byPane.values()) {
    const r = rootAgent(a, byPane);
    const sameTree = rootPane && r?.paneId === rootPane;
    const sameTab = tab && a.tabId === tab;
    if (sameTree || sameTab) out.push(a);
  }
  return out.length ? out : [agent];
}

function rootAgent(agent, byPane) {
  let cur = agent;
  const seen = new Set();
  while (cur?.hodParent && !seen.has(cur.paneId)) {
    seen.add(cur.paneId);
    const parent = byPane?.get(cur.hodParent);
    if (!parent) break;
    cur = parent;
  }
  return cur;
}

export function attachHerdrTeams(sessions, agents, { live = true } = {}) {
  const changed = [];
  const used = new Set();
  const list = sessions.filter((s) => s?.meta);
  const byPane = new Map();
  for (const a of agents) {
    if (a.paneId) byPane.set(a.paneId, a);
  }

  const bind = (s, agent) => {
    const next = {
      id: familyId(agent, byPane),
      label: teamLabel(agent, familyMembers(agent, byPane)),
      cwd: agent.cwd || "",
      paneId: agent.paneId,
      herdrName: agent.name,
      herdrKind: agent.kind,
      herdrStatus: agent.status,
      hodRole: agent.hodRole || null,
      hodRun: agent.hodRun || null,
      hodTask: agent.hodTask || null,
      hodParent: agent.hodParent || null,
      role: agent.hodRole || null,
      workspaceLabel: agent.workspaceLabel || "",
      tabNumber: agent.tabNumber ?? null,
    };
    if (!next.id) return;
    const prev = s.meta.team;
    if (sameTeam(prev, next)) return;
    s.meta.team = next;
    changed.push(s.meta.id);
  };

  for (const s of list) {
    const agent = agents.find((a) => a.sessionId && a.sessionId === s.meta.id);
    if (!agent) continue;
    bind(s, agent);
    used.add(agent);
  }

  for (const agent of agents) {
    if (used.has(agent)) continue;
    // Known session id already failed to match — do not steal another session by cwd.
    if (agent.sessionId) continue;
    const cwd = normCwd(agent.cwd);
    if (!cwd) continue;
    const cands = list
      .filter((s) => !s.meta.team && kindMatches(s.meta.runtime, agent.kind) && normCwd(s.meta.cwd) === cwd)
      .sort((a, b) => (b.meta.mtimeMs || 0) - (a.meta.mtimeMs || 0));
    if (cands[0]) {
      bind(cands[0], agent);
      used.add(agent);
    }
  }

  if (live) {
    for (const s of list) {
      if (!s.meta.team) continue;
      if (stillOnLivePane(s, agents)) continue;
      delete s.meta.team;
      changed.push(s.meta.id);
    }
  }

  return changed;
}

function stillOnLivePane(s, agents) {
  if (agents.some((a) => a.sessionId && a.sessionId === s.meta.id)) return true;
  const paneId = s.meta.team?.paneId;
  if (!paneId) return false;
  const occupant = agents.find((a) => a.paneId === paneId);
  if (!occupant) return false;
  // Pane reused by a different known session — drop the stale teammate.
  if (occupant.sessionId && occupant.sessionId !== s.meta.id) return false;
  return !occupant.sessionId;
}

function teamLabel(agent, members = []) {
  const pool = members.length ? members : [agent];
  const bits = [];
  const ws = agent.workspaceLabel
    || pool.map((a) => a.workspaceLabel).find(Boolean)
    || path.basename(String(agent.cwd || "").replace(/\/+$/, ""));
  if (ws) bits.push(ws);
  const tabNumber = agent.tabNumber ?? pool.map((a) => a.tabNumber).find((n) => n != null && n !== "");
  const tabLabel = agent.tabLabel || pool.map((a) => a.tabLabel).find(Boolean);
  if (tabNumber != null && tabNumber !== "") bits.push(`tab ${tabNumber}`);
  else if (tabLabel) bits.push(`tab ${tabLabel}`);
  const task = pool.map((a) => a.hodTask).find(Boolean);
  const run = pool.map((a) => a.hodRun).find(Boolean);
  if (task) bits.push(task);
  else if (run) bits.push(run);
  return bits.join(" · ") || agent.tabId || "herdr";
}

function kindMatches(runtime, herdrKind) {
  if (runtime === herdrKind) return true;
  if (runtime === "other" && herdrKind === "grok") return true;
  return false;
}

function normCwd(cwd) {
  return String(cwd || "").replace(/\/+$/, "").toLowerCase();
}

function sameTeam(a, b) {
  if (!a || !b) return false;
  return a.id === b.id && a.paneId === b.paneId && a.herdrName === b.herdrName && a.hodRole === b.hodRole;
}
