// Office compiler — PURE (no IO). Collapse VisualEvent[] into people / tickets /
// handoffs / artifacts. The dashboard renders this object; it does not re-parse events.

import { resolveRole, roleLabel, parseRoleDirective, matchDirective, canonicalizeRole } from "./roles.mjs";

const LEAD = "lead";
const USER = "user";

const SUB_TOOLS = /^(Task|TaskCreate|spawn_subagent|subagent|Agent)$/i;
const NOISE_PROMPT = /^<(environment_context|turn_aborted)\b/i;

export function emptyOffice() {
  return {
    brief: "",
    outcome: "",
    directives: [],
    people: [blankPerson(LEAD, "lead")],
    tickets: [],
    handoffs: [],
    artifacts: [],
    counts: { people: 1, doing: 0, blocked: 0, done: 0 },
  };
}

export function buildOffice(events = []) {
  const people = new Map();
  ensurePerson(people, LEAD, "lead");

  const tickets = [];
  const handoffs = [];
  const openTicket = new Map();
  const filesByPerson = new Map();
  const toolsByPerson = new Map();
  const eventIdsByPerson = new Map();

  let mode = "sequential";
  const openSubs = [];
  let current = LEAD;
  let brief = "";
  let outcome = "";
  const directives = [];
  let sawSessionEnd = false;

  const addEvent = (pid, ev) => {
    if (!ev?.id) return;
    const list = eventIdsByPerson.get(pid) || [];
    list.push(ev.id);
    eventIdsByPerson.set(pid, list);
    const p = people.get(pid);
    if (p && ev.ts && ev.ts > (p.lastTs || "")) p.lastTs = ev.ts;
    if (p && ev.kind) p.lastKind = ev.kind;
  };

  const bumpTool = (pid, name) => {
    if (!name) return;
    const bag = toolsByPerson.get(pid) || new Map();
    bag.set(name, (bag.get(name) || 0) + 1);
    toolsByPerson.set(pid, bag);
    const p = people.get(pid);
    if (p) p.toolCount += 1;
  };

  const bumpFile = (pid, ref) => {
    if (!ref?.path) return;
    const bag = filesByPerson.get(pid) || new Map();
    const rec = bag.get(ref.path) || { path: ref.path, read: 0, write: 0, edit: 0, bash: 0, total: 0 };
    const op = ref.op || "read";
    rec[op] = (rec[op] || 0) + 1;
    rec.total += 1;
    bag.set(ref.path, rec);
    filesByPerson.set(pid, bag);
  };

  for (const ev of events) {
    if (!ev || ev.kind === "session_start") continue;
    if (ev.kind === "session_end") {
      sawSessionEnd = true;
      addEvent(LEAD, ev);
      continue;
    }
    if (ev.kind === "user_prompt" && isNoisePrompt(ev)) continue;

    if (ev.kind === "user_prompt") {
      const rawText = ev.detail || ev.label || "";
      const directive = parseRoleDirective(rawText);
      if (directive) directives.push(directive);
      const title = oneLine(directive?.task || rawText, 140);
      if (title) brief = title;
      const ticket = {
        id: `brief-${ev.id || tickets.length}`,
        title: title || "User brief",
        fromId: USER,
        toId: LEAD,
        status: "doing",
        startTs: ev.ts || "",
        endTs: null,
        durationMs: null,
      };
      closeTicket(openTicket.get(LEAD), ev.ts, "done");
      tickets.push(ticket);
      openTicket.set(LEAD, ticket);
      const lead = people.get(LEAD);
      lead.ticketId = ticket.id;
      if (!lead.currentWork) lead.currentWork = ticket.title;
      if (lead.status === "idle") lead.status = "doing";
      handoffs.push(makeHandoff("brief", USER, LEAD, ticket.id, title, ev.ts));
      current = LEAD;
      addEvent(LEAD, ev);
      continue;
    }

    if (isSubStart(ev)) {
      const id = personIdFrom(ev);
      ensurePerson(people, id, "subagent");
      if (openSubs.length > 0) mode = "parallel";
      openSubs.push(id);
      current = mode === "parallel" ? LEAD : id;

      const title = ticketTitleFromStart(ev);
      const ticket = {
        id: `t-${id}-${tickets.length}`,
        title,
        fromId: LEAD,
        toId: id,
        status: "doing",
        startTs: ev.ts || "",
        endTs: null,
        durationMs: null,
      };
      tickets.push(ticket);
      openTicket.set(id, ticket);
      const sub = people.get(id);
      sub.ticketId = ticket.id;
      sub.currentWork = title;
      sub.status = "doing";
      if (people.get(LEAD).status !== "blocked") people.get(LEAD).status = "doing";
      handoffs.push(makeHandoff("delegate", LEAD, id, ticket.id, title, ev.ts));
      addEvent(LEAD, ev);
      addEvent(id, ev);
      bumpTool(LEAD, ev.toolName || "subagent");
      continue;
    }

    if (isSubStop(ev)) {
      const id = matchOpenSub(ev, openSubs);
      const idx = openSubs.lastIndexOf(id);
      if (idx >= 0) openSubs.splice(idx, 1);
      current = mode === "parallel" ? LEAD : (openSubs[openSubs.length - 1] || LEAD);
      if (openSubs.length <= 1) mode = "sequential";

      const ticket = openTicket.get(id);
      const failed = ev.kind === "tool_error";
      closeTicket(ticket, ev.ts, failed ? "failed" : "done");
      openTicket.delete(id);
      const sub = people.get(id) || ensurePerson(people, id, "subagent");
      sub.status = failed ? "blocked" : "done";
      if (failed) sub.errorCount += 1;
      if (ticket) sub.currentWork = ticket.title;
      handoffs.push(makeHandoff(
        "return",
        id,
        LEAD,
        ticket?.id || null,
        oneLine(ev.detail || ev.label || (failed ? "failed" : "done"), 140),
        ev.ts,
      ));
      addEvent(id, ev);
      continue;
    }

    const pid = attribute(ev, { mode, current, people });
    if (!people.has(pid)) ensurePerson(people, pid, pid === LEAD ? "lead" : "subagent");
    addEvent(pid, ev);

    if (ev.kind === "agent_message") {
      const text = oneLine(ev.detail || ev.label, 140);
      if (text && !isNoiseMessage(text)) {
        const p = people.get(pid);
        p.currentWork = text;
        if (pid === LEAD) outcome = text;
      }
    }
    if (ev.kind === "tool_call") {
      bumpTool(pid, ev.toolName || "tool");
      const p = people.get(pid);
      if (p.status !== "blocked") p.status = "doing";
      const file = ev.filePaths?.[0]?.path;
      p.currentWork = file
        ? `${ev.toolName || "tool"} ${basename(file)}`
        : (ev.toolName || p.currentWork);
    }
    if (ev.kind === "tool_error") {
      const p = people.get(pid);
      p.status = "blocked";
      p.errorCount += 1;
    }
    if (ev.kind === "tool_output") {
      const p = people.get(pid);
      if (p.status === "blocked") p.status = openSubs.includes(pid) || openTicket.has(pid) ? "doing" : p.status;
    }
    for (const f of ev.filePaths || []) bumpFile(pid, f);
  }

  finalizeStatuses(people, { sawSessionEnd, openSubs, openTicket });
  applyRolesAndBelts(people, { toolsByPerson, filesByPerson, eventIdsByPerson, tickets });
  applyWorkSummaries(people, brief, outcome);
  applyLeadAssignments(people, tickets);
  stampRuntime(people, firstRuntime(events));

  const list = orderPeople(people);
  const artifacts = buildArtifacts(filesByPerson);
  return {
    brief,
    outcome: outcome && outcome !== brief ? outcome : "",
    directives,
    people: list,
    tickets,
    handoffs,
    artifacts,
    counts: {
      people: list.length,
      doing: list.filter((p) => p.status === "doing").length,
      blocked: list.filter((p) => p.status === "blocked").length,
      done: list.filter((p) => p.status === "done").length,
    },
  };
}

function attribute(ev, { mode, current, people }) {
  if (ev.kind === "user_prompt") return LEAD;
  if (ev.agentId && people.has(ev.agentId)) return ev.agentId;
  if (ev.agentId) return ev.agentId;
  return mode === "sequential" ? current : LEAD;
}

function isSubStart(ev) {
  if (ev.kind === "subagent_start") return true;
  return ev.kind === "tool_call" && SUB_TOOLS.test(ev.toolName || "");
}

function isSubStop(ev) {
  if (ev.kind === "subagent_stop") return true;
  return (ev.kind === "tool_output" || ev.kind === "tool_error") && SUB_TOOLS.test(ev.toolName || "");
}

function personIdFrom(ev) {
  return ev.agentId || ev.toolUseId || ev.id || `sub-${Math.random().toString(36).slice(2, 8)}`;
}

function matchOpenSub(ev, openSubs) {
  const id = ev.agentId || ev.toolUseId;
  if (id && openSubs.includes(id)) return id;
  if (id) return id;
  return openSubs[openSubs.length - 1] || personIdFrom(ev);
}

function isNoisePrompt(ev) {
  return NOISE_PROMPT.test(String(ev.label || ev.detail || "").trim());
}

function ticketTitleFromStart(ev) {
  const raw = ev.detail || ev.label || "";
  try {
    const j = JSON.parse(raw);
    const text = j.description || j.prompt || j.task || j.title || j.subagent_type;
    if (text) return oneLine(text, 80);
  } catch { /* not JSON */ }
  if (ev.label && !SUB_TOOLS.test(ev.label)) return oneLine(ev.label, 80);
  return oneLine(raw || `subagent ${ev.agentId || ev.toolUseId || ""}`.trim(), 80);
}

function makeHandoff(kind, fromId, toId, ticketId, summary, ts) {
  return {
    id: `h-${kind}-${fromId}-${toId}-${ts || ""}`,
    kind,
    fromId,
    toId,
    ticketId: ticketId || null,
    summary: summary || "",
    ts: ts || "",
  };
}

function closeTicket(ticket, ts, status) {
  if (!ticket || ticket.endTs) return;
  ticket.status = status;
  ticket.endTs = ts || ticket.endTs;
  ticket.durationMs = deltaMs(ticket.startTs, ticket.endTs);
}

function ensurePerson(people, id, kind) {
  if (people.has(id)) return people.get(id);
  const p = blankPerson(id, kind);
  people.set(id, p);
  return p;
}

function blankPerson(id, kind) {
  return {
    id,
    kind,
    label: kind === "lead" ? "Lead" : shortId(id),
    roleHint: kind === "lead" ? "lead" : "unknown",
    roleSource: kind === "lead" ? "lead" : "inferred",
    status: "idle",
    currentWork: "",
    ticketId: null,
    tools: [],
    toolBelt: [],
    files: [],
    fileCount: 0,
    toolCount: 0,
    errorCount: 0,
    lastTs: "",
    lastKind: "",
    eventIds: [],
    runtime: "",
    herdrName: "",
    assignments: [],
  };
}

function firstRuntime(events) {
  for (const ev of events) {
    if (ev?.runtime) return ev.runtime;
  }
  return "";
}

function stampRuntime(people, runtime) {
  if (!runtime) return;
  for (const p of people.values()) {
    p.runtime = p.runtime || runtime;
    if (p.kind === "lead") p.label = runtimeLabel(runtime);
  }
}

function finalizeStatuses(people, { sawSessionEnd, openSubs }) {
  const anySubDoing = [...people.values()].some((p) => p.kind === "subagent" && p.status === "doing");
  for (const p of people.values()) {
    if (p.kind === "subagent") {
      if (openSubs.includes(p.id) && p.status !== "blocked") p.status = "doing";
      continue;
    }
    if (p.status === "blocked") continue;
    if (anySubDoing) {
      p.status = "doing";
      if (!p.currentWork) p.currentWork = "Coordinating";
      continue;
    }
    if (p.lastKind === "tool_call" || p.lastKind === "reasoning") {
      p.status = "doing";
      continue;
    }
    if (p.toolCount > 0 || (sawSessionEnd && p.ticketId)) {
      p.status = "done";
    } else {
      p.status = "idle";
    }
  }
}

function applyRolesAndBelts(people, { toolsByPerson, filesByPerson, eventIdsByPerson, tickets }) {
  for (const p of people.values()) {
    const toolMap = toolsByPerson.get(p.id) || new Map();
    const belt = [...toolMap.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
    p.toolBelt = belt;
    p.tools = belt.slice(0, 4);
    const fileMap = filesByPerson.get(p.id) || new Map();
    p.files = [...fileMap.values()].sort((a, b) => b.total - a.total);
    p.fileCount = p.files.length;
    p.eventIds = eventIdsByPerson.get(p.id) || [];
    const ticket = tickets.find((t) => t.id === p.ticketId);
    const title = ticket?.title || p.currentWork || "";
    const resolved = resolveRole({ kind: p.kind, title, toolMap });
    p.roleHint = p.kind === "lead"
      ? "lead"
      : (resolved.role === "unknown" ? "worker" : resolved.role);
    p.roleSource = resolved.roleSource;
    if (p.kind === "subagent") p.label = roleLabel(p.roleHint);
  }
}

function applyLeadAssignments(people, tickets) {
  const lead = people.get(LEAD);
  if (!lead) return;
  const items = [];
  for (const t of tickets || []) {
    if (!t || t.fromId !== LEAD || t.toId === LEAD || t.toId === USER) continue;
    const child = people.get(t.toId);
    const who = assignmentWho(child);
    const task = oneLine(t.title || child?.currentWork || "", 100);
    if (!task) continue;
    items.push({
      who,
      role: child?.roleHint || "",
      task,
      status: t.status || child?.status || "",
    });
  }
  lead.assignments = items;
  if (items.length) {
    lead.currentWork = items.map((a) => `${a.who}: ${a.task}`).join("\n");
  }
}

function assignmentWho(person) {
  if (!person) return "agent";
  const spawn = spawnOrEmpty(person);
  if (spawn) return spawn;
  if (person.roleHint && person.roleHint !== "unknown") return roleLabel(person.roleHint);
  return person.label || "agent";
}

function applyWorkSummaries(people, brief, outcome) {
  for (const p of people.values()) {
    if (p.kind !== "lead") continue;
    if (p.currentWork && p.currentWork !== brief) continue;
    if (outcome && outcome !== brief) {
      p.currentWork = outcome;
      continue;
    }
    if (p.toolCount > 0) p.currentWork = summarizeTools(p);
  }
}

function summarizeTools(p) {
  const top = (p.tools || []).map((t) => (t.count > 1 ? `${t.name} ×${t.count}` : t.name));
  const file = p.files?.[0]?.path;
  if (file) return `${basename(file)} · ${top.slice(0, 3).join(", ")}`;
  if (top.length) return top.slice(0, 3).join(" · ");
  return p.currentWork || "";
}

function isNoiseMessage(text) {
  const t = String(text || "").trim();
  if (!t) return true;
  if (t === "complete") return true;
  if (/^▶\s*turn started/i.test(t)) return true;
  if (/^⏹\s*turn aborted/i.test(t)) return true;
  return false;
}

function orderPeople(people) {
  const lead = people.get(LEAD);
  const rest = [...people.values()]
    .filter((p) => p.id !== LEAD)
    .sort((a, b) => String(a.lastTs).localeCompare(String(b.lastTs)));
  return lead ? [lead, ...rest] : rest;
}

function buildArtifacts(filesByPerson) {
  const byPath = new Map();
  for (const [pid, files] of filesByPerson) {
    for (const rec of files.values()) {
      const art = byPath.get(rec.path) || {
        path: rec.path,
        read: 0,
        write: 0,
        edit: 0,
        bash: 0,
        total: 0,
        touchedBy: [],
        lastTs: "",
      };
      art.read += rec.read;
      art.write += rec.write;
      art.edit += rec.edit;
      art.bash += rec.bash || 0;
      art.total += rec.total;
      if (!art.touchedBy.includes(pid)) art.touchedBy.push(pid);
      byPath.set(rec.path, art);
    }
  }
  return [...byPath.values()].sort((a, b) => b.total - a.total).slice(0, 12);
}

function oneLine(text, max = 80) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function basename(p) {
  const s = String(p || "");
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return i >= 0 ? s.slice(i + 1) : s;
}

function shortId(id) {
  const s = String(id || "");
  if (s.length <= 10) return s;
  return s.slice(0, 8);
}

function deltaMs(a, b) {
  const t1 = Date.parse(a);
  const t2 = Date.parse(b);
  if (isNaN(t1) || isNaN(t2)) return null;
  return Math.max(0, t2 - t1);
}

// Merge Herdr teammates into one floor: controller = Lead, others = staff.
export function mergeTeamView(members = []) {
  const live = members.filter((m) => m?.office && m?.meta);
  if (live.length < 2) {
    const only = live[0];
    return {
      office: only?.office || emptyOffice(),
      heatmap: only?.heatmap || [],
    };
  }
  return {
    office: mergeTeamOffice(live),
    heatmap: mergeHeatmaps(live.map((m) => m.heatmap || [])),
  };
}

function mergeTeamOffice(members) {
  const allDirectives = members.flatMap((m) => m.office?.directives || []);
  const leadMember = pickTeamLead(members, allDirectives);
  const workers = members.filter((m) => m.meta.id !== leadMember.meta.id);
  const src = leadMember.office || emptyOffice();
  const leadSrc = (src.people || []).find((p) => p.kind === "lead") || blankPerson(LEAD, "lead");
  const ownSubs = (src.people || []).filter((p) => p.kind === "subagent");

  const lead = {
    ...leadSrc,
    id: LEAD,
    kind: "lead",
    label: runtimeLabel(leadMember.meta.runtime),
    roleHint: "lead",
    roleSource: assignedRole(leadMember, allDirectives)?.source || "lead",
    sessionId: leadMember.meta.id,
    runtime: leadMember.meta.runtime,
    herdrName: leadMember.meta.team?.herdrName || "",
  };

  const staff = workers.map((w) => personFromMember(w, allDirectives));
  const people = [lead, ...ownSubs, ...staff];

  const tickets = [...(src.tickets || [])];
  const handoffs = [...(src.handoffs || [])];
  for (const w of workers) {
    const pid = herdrPersonId(w);
    const title = w.office.brief || w.office.outcome || w.office.people?.[0]?.currentWork || "assigned work";
    tickets.push({
      id: `herdr-t-${w.meta.id}`,
      title,
      fromId: LEAD,
      toId: pid,
      status: staffStatusToTicket(w),
      startTs: w.meta.startedAt || "",
      endTs: w.meta.endedAt || null,
      durationMs: null,
    });
    handoffs.push(makeHandoff("delegate", LEAD, pid, `herdr-t-${w.meta.id}`, title, w.meta.startedAt));
    if (w.office.people?.[0]?.status === "done" || w.office.outcome) {
      handoffs.push(makeHandoff(
        "return",
        pid,
        LEAD,
        `herdr-t-${w.meta.id}`,
        w.office.outcome || w.office.people?.[0]?.currentWork || "done",
        w.meta.mtimeMs ? new Date(w.meta.mtimeMs).toISOString() : "",
      ));
    }
  }

  const artifacts = mergeArtifacts([
    remapArtifacts(src.artifacts, LEAD),
    ...workers.map((w) => remapArtifacts(w.office.artifacts, herdrPersonId(w))),
  ]);

  const delegated = [...ownSubs, ...staff];
  lead.assignments = delegated.map((p) => {
    const ticket = tickets.find((t) => t.toId === p.id);
    return {
      who: assignmentWho(p),
      role: p.roleHint || "",
      task: oneLine(ticket?.title || p.currentWork || "", 100),
      status: ticket?.status || p.status || "",
    };
  }).filter((a) => a.task);
  if (lead.assignments.length) {
    lead.currentWork = lead.assignments.map((a) => `${a.who}: ${a.task}`).join("\n");
  }

  return {
    brief: src.brief || workers.find((w) => w.office.brief)?.office.brief || "",
    outcome: src.outcome || workers.find((w) => w.office.outcome)?.office.outcome || "",
    directives: [...(src.directives || []), ...workers.flatMap((w) => w.office.directives || [])],
    people,
    tickets,
    handoffs,
    artifacts,
    teamLabel: leadMember.meta.team?.label || "",
    counts: {
      people: people.length,
      doing: people.filter((p) => p.status === "doing").length,
      blocked: people.filter((p) => p.status === "blocked").length,
      done: people.filter((p) => p.status === "done").length,
    },
  };
}

function assignedRole(member, directives = []) {
  const override = canonicalizeRole(member.meta?.roleOverride);
  if (override) return { role: override, source: "user" };
  const hod = canonicalizeRole(member.meta?.team?.hodRole || member.meta?.team?.role);
  if (hod) return { role: hod, source: "hod" };
  const directive = matchDirective(directives, {
    runtime: member.meta?.runtime,
    herdrName: member.meta?.team?.herdrName,
  });
  if (directive) return { role: directive.role, source: "user" };
  return null;
}

function pickTeamLead(members, directives = []) {
  const byAssign = members.find((m) => assignedRole(m, directives)?.role === "lead");
  if (byAssign) return byAssign;
  const typer = members.find((m) => (m.office?.directives || []).length);
  if (typer) return typer;
  return [...members].sort((a, b) => String(a.meta.startedAt || "").localeCompare(String(b.meta.startedAt || "")))[0];
}

function personFromMember(member, directives = []) {
  const src = (member.office.people || []).find((p) => p.kind === "lead") || blankPerson(LEAD, "lead");
  const runtime = member.meta.runtime || "other";
  const assigned = assignedRole(member, directives);
  const toolMap = new Map((src.toolBelt || src.tools || []).map((t) => [t.name, t.count]));
  const spawn = String(member.meta.team?.herdrName || "").trim();
  const resolved = resolveRole({
    kind: "subagent",
    hodRole: member.meta.team?.hodRole,
    title: member.office.brief || member.office.outcome || src.currentWork,
    name: spawn,
    toolMap,
  });
  if (assigned) {
    resolved.role = assigned.role;
    resolved.roleSource = assigned.source;
  }
  if (resolved.role === "lead" || resolved.role === "unknown") resolved.role = "worker";
  return {
    ...src,
    id: herdrPersonId(member),
    kind: "subagent",
    label: spawn || roleLabel(resolved.role),
    roleHint: resolved.role,
    roleSource: resolved.roleSource,
    currentWork: member.office.outcome || src.currentWork || member.office.brief || "",
    ticketId: `herdr-t-${member.meta.id}`,
    sessionId: member.meta.id,
    runtime,
    herdrName: spawn,
  };
}

function herdrPersonId(member) {
  return `herdr:${member.meta.runtime}:${member.meta.id}`;
}

function runtimeLabel(runtime) {
  if (!runtime || runtime === "other") return "Agent";
  return String(runtime).charAt(0).toUpperCase() + String(runtime).slice(1);
}

function spawnOrEmpty(person) {
  const name = String(person?.herdrName || "").trim();
  if (!name) return "";
  const rt = String(person.runtime || "").toLowerCase();
  if (name.toLowerCase() === rt) return "";
  if (name.toLowerCase() === runtimeLabel(person.runtime).toLowerCase()) return "";
  return name;
}

export function applyAssignedRole(office, role, { source = "user" } = {}) {
  const next = canonicalizeRole(role);
  if (!office || !next) return office;
  return {
    ...office,
    people: (office.people || []).map((p) => {
      if (p.kind !== "lead") return p;
      return { ...p, roleHint: next, roleSource: source };
    }),
  };
}

function staffStatusToTicket(member) {
  const st = member.office.people?.[0]?.status;
  if (st === "blocked") return "failed";
  if (st === "doing") return "doing";
  return "done";
}

function remapArtifacts(list, pid) {
  return (list || []).map((a) => ({
    ...a,
    touchedBy: [pid],
  }));
}

function mergeArtifacts(lists) {
  const byPath = new Map();
  for (const list of lists) {
    for (const rec of list || []) {
      if (!rec?.path) continue;
      const art = byPath.get(rec.path) || {
        path: rec.path, read: 0, write: 0, edit: 0, bash: 0, total: 0, touchedBy: [], lastTs: "",
      };
      art.read += rec.read || 0;
      art.write += rec.write || 0;
      art.edit += rec.edit || 0;
      art.bash += rec.bash || 0;
      art.total += rec.total || 0;
      for (const id of rec.touchedBy || []) {
        if (!art.touchedBy.includes(id)) art.touchedBy.push(id);
      }
      byPath.set(rec.path, art);
    }
  }
  return [...byPath.values()].sort((a, b) => b.total - a.total).slice(0, 12);
}

function mergeHeatmaps(lists) {
  const byPath = new Map();
  for (const list of lists) {
    for (const rec of list || []) {
      if (!rec?.path) continue;
      const art = byPath.get(rec.path) || {
        path: rec.path, read: 0, write: 0, edit: 0, bash: 0, total: 0, lastTs: "",
      };
      art.read += rec.read || 0;
      art.write += rec.write || 0;
      art.edit += rec.edit || 0;
      art.bash += rec.bash || 0;
      art.total += rec.total || 0;
      if (rec.lastTs > (art.lastTs || "")) art.lastTs = rec.lastTs;
      byPath.set(rec.path, art);
    }
  }
  return [...byPath.values()].sort((a, b) => b.total - a.total).slice(0, 80);
}
