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

function isFamilyId(id) {
  const s = String(id || "");
  return s.startsWith("orch:") || s.startsWith("run:");
}

function familyId(agent, byPane, sessions = []) {
  // Only Herdr-spawned roles (worker-1, reviewer-1, …) and their controller
  // share a team. A plain Grok pane on the same tab is a different session.
  const historical = historicalFamilyId(agent, sessions);
  if (!isOrchestrationMember(agent, byPane) && !historical) {
    return agent.paneId ? `pane:${agent.paneId}` : "";
  }
  if (historical) return historical;
  const members = familyMembers(agent, byPane).filter((a) => isOrchestrationMember(a, byPane));
  const run = members.map((a) => a.hodRun).find(Boolean);
  if (run) return `run:${run}`;
  const tab = agent.tabId || members.map((a) => a.tabId).find(Boolean);
  if (tab) return `orch:${tab}`;
  return "";
}

function historicalFamilyId(agent, sessions = []) {
  let fallback = "";
  for (const s of sessions) {
    const team = s?.meta?.team;
    if (!isFamilyId(team?.id)) continue;
    if (agent.sessionId && idsMatch(agent.sessionId, s.meta.id)) return team.id;
    if (agent.paneId && team.paneId && agent.paneId === team.paneId) return team.id;
    if (agent.tabId && team.tabId && agent.tabId === team.tabId) fallback = fallback || team.id;
    if (agent.name && team.herdrName && agent.name === team.herdrName) fallback = fallback || team.id;
  }
  return fallback;
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

  const note = (id) => {
    if (id && !changed.includes(id)) changed.push(id);
  };

  applyHistoricalTeams(list, collectHerdrHistory(list), note);

  const bind = (s, agent) => {
    const next = {
      id: familyId(agent, byPane, list),
      label: teamLabel(agent, familyMembers(agent, byPane)),
      cwd: agent.cwd || "",
      paneId: agent.paneId,
      tabId: agent.tabId || "",
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
      exited: false,
    };
    applyTeam(s, next, note);
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
    const hits = list.filter((s) => {
      if (s.meta.team && !s.meta.team.exited && s.meta.team.herdrName !== agent.name) return false;
      return titlesMatch(s.meta.title, agent.terminalTitle);
    });
    if (hits.length !== 1) continue;
    bind(hits[0], agent);
    used.add(agent);
  }

  if (live) {
    for (const s of list) {
      if (!s.meta.team) continue;
      if (stillOnLivePane(s, agents)) {
        if (s.meta.team.exited) {
          s.meta.team = { ...s.meta.team, exited: false };
          note(s.meta.id);
        }
        continue;
      }
      if (replacedByDifferentLiveSession(s, agents)) {
        delete s.meta.team;
        note(s.meta.id);
        continue;
      }
      // Agent left the pane: keep the desk in the historical session.
      if (!s.meta.team.exited) {
        s.meta.team = { ...s.meta.team, exited: true, herdrStatus: "exited" };
        note(s.meta.id);
      }
    }
  }

  return changed;
}

function applyTeam(s, next, note) {
  if (!s?.meta || !next?.id) return;
  const prev = s.meta.team;
  if (isFamilyId(prev?.id) && !isFamilyId(next.id)) {
    next = { ...next, id: prev.id, label: prev.label || next.label, tabId: next.tabId || prev.tabId };
  }
  if (isFamilyId(prev?.id) && isFamilyId(next.id) && prev.id !== next.id) {
    const prevTab = prev.id.startsWith("orch:") && prev.id.includes(":");
    const nextIsSessionFallback = next.id.startsWith("orch:") && /[0-9a-f]{8}-[0-9a-f]{4}-/i.test(next.id);
    if (prevTab && nextIsSessionFallback) {
      next = { ...next, id: prev.id, label: prev.label || next.label, tabId: next.tabId || prev.tabId };
    }
  }
  if (sameTeam(prev, next) && Boolean(prev.exited) === Boolean(next.exited)) return;
  s.meta.team = next;
  note(s.meta.id);
}

function applyHistoricalTeams(sessions, history, note) {
  if (!history.length) return;
  const byId = new Map(sessions.map((s) => [s.meta.id, s]));
  for (const group of history) {
    const lead = byId.get(group.controllerId);
    if (lead && !roleFromAgentName(lead.meta.team?.herdrName)) {
      applyTeam(lead, {
        id: group.familyId,
        label: group.label,
        cwd: lead.meta.cwd || group.cwd || "",
        paneId: lead.meta.team?.paneId || "",
        tabId: group.tabId || "",
        herdrName: lead.meta.team?.herdrName || "",
        herdrKind: lead.meta.runtime || "",
        herdrStatus: lead.meta.team?.herdrStatus || "idle",
        herdrSessionId: lead.meta.id,
        terminalTitle: "",
        hodRole: lead.meta.team?.hodRole || null,
        hodRelation: lead.meta.team?.hodRelation || null,
        hodRun: lead.meta.team?.hodRun || null,
        hodTask: lead.meta.team?.hodTask || null,
        hodParent: lead.meta.team?.hodParent || null,
        role: lead.meta.team?.role || null,
        workspaceLabel: lead.meta.team?.workspaceLabel || path.basename(String(lead.meta.cwd || "").replace(/\/+$/, "")),
        tabNumber: lead.meta.team?.tabNumber ?? null,
        exited: false,
      }, note);
    }
    for (const spawn of group.spawns) {
      const hit = matchHistoricalSpawn(sessions, spawn, group.controllerId);
      if (!hit) continue;
      applyTeam(hit, {
        id: group.familyId,
        label: group.label,
        cwd: spawn.cwd || hit.meta.cwd || "",
        paneId: spawn.paneId || "",
        tabId: spawn.tabId || group.tabId || "",
        herdrName: spawn.name,
        herdrKind: spawn.kind || hit.meta.runtime || "",
        herdrStatus: spawn.status || "exited",
        herdrSessionId: spawn.sessionId || hit.meta.id,
        terminalTitle: spawn.title || hit.meta.title || "",
        hodRole: null,
        hodRelation: null,
        hodRun: null,
        hodTask: null,
        hodParent: null,
        role: null,
        workspaceLabel: path.basename(String(hit.meta.cwd || spawn.cwd || "").replace(/\/+$/, "")),
        tabNumber: null,
        exited: true,
      }, note);
    }
  }
}

function matchHistoricalSpawn(sessions, spawn, controllerId) {
  if (spawn.sessionId) {
    const bySid = sessions.find((s) => idsMatch(s.meta.id, spawn.sessionId));
    if (bySid) return bySid;
  }
  const title = spawn.title;
  if (!title) return null;
  const hits = sessions.filter((s) => {
    if (s.meta.id === controllerId) return false;
    if (s.meta.team?.herdrName && spawn.name && s.meta.team.herdrName !== spawn.name && !s.meta.team.exited) {
      return false;
    }
    return titlesMatch(s.meta.title, title);
  });
  return hits.length === 1 ? hits[0] : null;
}

export function collectHerdrHistory(sessions) {
  const groups = [];
  for (const s of sessions || []) {
    const spawns = herdrSpawnsFromEvents(s?.events || []);
    if (!spawns.length) continue;
    const tabId = spawns.map((x) => x.tabId).find(Boolean) || "";
    const familyId = tabId ? `orch:${tabId}` : `orch:${s.meta.id}`;
    const cwd = s.meta?.cwd || spawns.map((x) => x.cwd).find(Boolean) || "";
    const ws = path.basename(String(cwd).replace(/\/+$/, ""));
    const label = [ws, tabId ? `tab ${tabId}` : ""].filter(Boolean).join(" · ") || "herdr";
    groups.push({
      controllerId: s.meta.id,
      familyId,
      tabId,
      cwd,
      label,
      spawns,
    });
  }
  return groups;
}

function herdrSpawnsFromEvents(events) {
  const byName = new Map();
  const pending = new Map();
  for (const ev of events || []) {
    if (ev?.kind === "tool_call") {
      const inv = parseHerdrAgentInvocation(ev.detail || ev.label);
      if (inv) pending.set(ev.toolUseId || ev.id, inv);
      continue;
    }
    if (ev?.kind !== "tool_output" && ev?.kind !== "tool_error") continue;
    // Only a matching `herdr agent start/prompt` call counts. Copied JSON in
    // a python/cat tool result must not invent a historical teammate.
    const inv = pending.get(ev.toolUseId);
    if (!inv) continue;
    const parsed = parseHerdrCliJson(ev.detail);
    const failed = ev.kind === "tool_error" || Boolean(parsed?.error);
    const agent = parsed?.result?.agent || parsed?.agent || {};
    const name = String(agent.name || inv.name || "").trim();
    if (!name || name.startsWith("-")) continue;
    const action = herdrActionOf(parsed, inv) || inv.action;
    if (action === "start" && failed) continue;
    if (action !== "start" && action !== "prompt") continue;
    const prev = byName.get(name) || {
      name,
      paneId: "",
      tabId: "",
      kind: "",
      title: "",
      cwd: "",
      sessionId: null,
      status: "",
    };
    if (agent.pane_id || agent.paneId) prev.paneId = agent.pane_id || agent.paneId;
    if (agent.tab_id || agent.tabId) prev.tabId = agent.tab_id || agent.tabId;
    const kind = agent.agent || agent.kind;
    if (typeof kind === "string" && kind && kind !== "id") prev.kind = kind;
    const title = agent.terminal_title_stripped || agent.terminal_title || agent.terminalTitle;
    if (title && !/^[-–—\s]*grok\s*$/i.test(String(title).replace(/[⠦⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g, "").trim())) {
      prev.title = title;
    }
    if (agent.cwd) prev.cwd = agent.cwd;
    const sid = agent.agent_session?.value || agent.agentSession?.value;
    if (sid) prev.sessionId = sid;
    if (agent.agent_status || agent.status) prev.status = agent.agent_status || agent.status;
    byName.set(name, prev);
    pending.delete(ev.toolUseId);
  }
  return [...byName.values()];
}

function herdrActionOf(parsed, inv) {
  const id = String(parsed?.id || parsed?.result?.type || parsed?.type || "");
  if (id.includes("agent:start") || id === "agent_started") return "start";
  if (id.includes("agent:prompt") || id === "agent_prompted") return "prompt";
  if (inv?.action) return inv.action;
  return "";
}

/** `herdr agent start worker-1` / `herdr agent prompt worker-1 '…'` / hod dispatch. */
export function parseHerdrAgentInvocation(text) {
  const cmd = commandFromDetail(text);
  if (!cmd) return null;
  if (/\bherdr\s+agent\s+start\s+--help\b/.test(cmd)) return null;
  if (/\bherdr\s+agent\s+prompt\s+--help\b/.test(cmd)) return null;
  const hod = cmd.match(/\bhod\s+dispatch\s+start\b[\s\S]*?--name\s+(\S+)/);
  if (hod) return { action: "start", name: stripQuotes(hod[1]), text: "" };
  const start = cmd.match(/\bherdr\s+agent\s+start\s+(\S+)/);
  if (start && !start[1].startsWith("-")) {
    const kind = cmd.match(/--kind\s+(\S+)/);
    return { action: "start", name: stripQuotes(start[1]), kind: kind ? stripQuotes(kind[1]) : "", text: "" };
  }
  const prompt = cmd.match(/\bherdr\s+agent\s+prompt\s+(\S+)\s+([\s\S]*)$/);
  if (prompt && !prompt[1].startsWith("-")) {
    return { action: "prompt", name: stripQuotes(prompt[1]), text: promptTextFromArgv(prompt[2]) };
  }
  return null;
}

export function parseHerdrCliJson(text) {
  const raw = String(text || "");
  const start = raw.indexOf("{");
  if (start < 0) return null;
  if (!/cli:agent:(?:start|prompt)|agent_started|agent_prompted/.test(raw)) return null;
  const slice = raw.slice(start);
  try {
    return JSON.parse(slice);
  } catch { /* truncated tail output — pull the fields we still have */ }
  const id = (slice.match(/"id"\s*:\s*"(cli:agent:(?:start|prompt))"/) || [])[1];
  const err = (slice.match(/"error"\s*:\s*\{[^}]*"code"\s*:\s*"([^"]+)"/) || [])[1];
  if (!id && !err) return null;
  if (err) return { id: id || "cli:agent:start", error: { code: err } };
  return {
    id,
    result: {
      type: id === "cli:agent:start" ? "agent_started" : "agent_prompted",
      agent: {
        name: jsonField(slice, "name"),
        pane_id: jsonField(slice, "pane_id"),
        tab_id: jsonField(slice, "tab_id"),
        agent: jsonField(slice, "agent"),
        agent_status: jsonField(slice, "agent_status"),
        cwd: jsonField(slice, "cwd"),
        terminal_title_stripped: jsonField(slice, "terminal_title_stripped"),
        terminal_title: jsonField(slice, "terminal_title"),
      },
    },
  };
}

function commandFromDetail(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  try {
    const j = JSON.parse(raw);
    if (typeof j.command === "string") return j.command;
  } catch { /* not a full JSON blob */ }
  const m = raw.match(/"command"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (m) {
    try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; }
  }
  return raw;
}

function promptTextFromArgv(rest) {
  let s = String(rest || "").replace(/\s+--wait\b[\s\S]*$/, "").trim();
  s = stripQuotes(s);
  return s.replace(/\\n/g, " ").trim();
}

function stripQuotes(value) {
  const s = String(value || "").trim();
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
    return s.slice(1, -1);
  }
  return s;
}

function jsonField(text, key) {
  const m = String(text || "").match(new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`));
  return m ? m[1] : "";
}

function stillOnLivePane(s, agents) {
  if (agents.some((a) => a.sessionId && idsMatch(a.sessionId, s.meta.id))) return true;
  const occupant = agents.find((a) => a.paneId && a.paneId === s.meta.team?.paneId);
  if (!occupant || occupant.sessionId) return false;
  return titlesMatch(s.meta.title, occupant.terminalTitle)
    && occupant.name === s.meta.team?.herdrName;
}

function replacedByDifferentLiveSession(s, agents) {
  const team = s.meta.team;
  if (!team) return false;
  const bySession = agents.find((a) => a.sessionId && idsMatch(a.sessionId, s.meta.id));
  if (bySession) return false;
  const occupant = agents.find((a) => {
    if (team.paneId && a.paneId === team.paneId) return true;
    return Boolean(team.herdrName && a.name && a.name === team.herdrName);
  });
  if (!occupant) return false;
  // A live spawn with a known session id that is not this transcript:
  // this bind was pointing at the wrong chat.
  if (occupant.sessionId && !idsMatch(occupant.sessionId, s.meta.id)) return true;
  return false;
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
