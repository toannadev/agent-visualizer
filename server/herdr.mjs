// Optional Herdr snapshot — join Claude/Grok/Codex transcripts that share a pane tab.
// Fail closed: missing binary, timeout, or bad JSON never throws.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { parseHodRelation, parseHodRole, roleFromAgentName } from "./roles.mjs";

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
    terminalTitle: String(raw.terminal_title_stripped || raw.terminal_title || "").trim(),
    status: raw.agent_status || raw.status || "",
    hodRole: parseHodRole(tokenMap(raw).hod_role),
    hodRelation: parseHodRelation(tokenMap(raw).hod_relation),
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

function familyId(agent, byPane) {
  // Only Herdr-spawned roles (worker-1, reviewer-1, …) and their controller
  // share a team. A plain Grok pane on the same tab is a different session.
  if (!isOrchestrationMember(agent, byPane)) {
    return agent.paneId ? `pane:${agent.paneId}` : "";
  }
  const members = familyMembers(agent, byPane).filter((a) => isOrchestrationMember(a, byPane));
  const run = members.map((a) => a.hodRun).find(Boolean);
  if (run) return `run:${run}`;
  const tab = agent.tabId || members.map((a) => a.tabId).find(Boolean);
  if (tab) return `orch:${tab}`;
  return "";
}

function isOrchestrationMember(agent, byPane) {
  if (agent.hodRole || agent.hodParent || agent.hodRun) return true;
  if (roleFromAgentName(agent.name)) return true;
  const tab = agent.tabId;
  if (!tab || !byPane) return false;
  const onTab = [...byPane.values()].filter((a) => a.tabId === tab);
  const hasSpawn = onTab.some((a) => roleFromAgentName(a.name) || a.hodRole);
  if (!hasSpawn) return false;
  const untagged = onTab.filter((a) => !roleFromAgentName(a.name) && !a.hodRole);
  if (untagged.length === 1) return untagged[0].paneId === agent.paneId;
  // Several untagged panes on the tab: only the Claude controller joins.
  return agent.kind === "claude" && untagged.filter((a) => a.kind === "claude").length === 1;
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
      herdrSessionId: agent.sessionId || null,
      terminalTitle: agent.terminalTitle || "",
      hodRole: agent.hodRole || null,
      hodRelation: agent.hodRelation || null,
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
    const agent = agents.find((a) => a.sessionId && idsMatch(a.sessionId, s.meta.id));
    if (!agent) continue;
    bind(s, agent);
    used.add(agent);
  }

  // Grok Herdr agents often have no session id. Bind by OSC/title, which
  // matches that spawn's generated_title — never by shared cwd.
  for (const agent of agents) {
    if (used.has(agent) || agent.sessionId) continue;
    const title = titleKey(agent.terminalTitle);
    if (!title) continue;
    const hits = list.filter((s) => !s.meta.team && titlesMatch(s.meta.title, agent.terminalTitle));
    if (hits.length !== 1) continue;
    bind(hits[0], agent);
    used.add(agent);
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
  if (agents.some((a) => a.sessionId && idsMatch(a.sessionId, s.meta.id))) return true;
  const occupant = agents.find((a) => a.paneId && a.paneId === s.meta.team?.paneId);
  if (!occupant || occupant.sessionId) return false;
  return titlesMatch(s.meta.title, occupant.terminalTitle)
    && occupant.name === s.meta.team?.herdrName;
}

function titleKey(value) {
  return String(value || "")
    .replace(/\s*[-–—]\s*grok\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function titlesMatch(sessionTitle, agentTitle) {
  const a = titleKey(sessionTitle);
  const b = titleKey(agentTitle);
  return Boolean(a && b && a === b);
}

function idsMatch(a, b) {
  if (!a || !b) return false;
  return String(a).toLowerCase() === String(b).toLowerCase();
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
  return a.id === b.id && a.paneId === b.paneId && a.herdrName === b.herdrName
    && a.hodRole === b.hodRole && a.hodRelation === b.hodRelation
    && a.herdrSessionId === b.herdrSessionId;
}
