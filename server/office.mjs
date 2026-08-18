// Office compiler — PURE (no IO). Collapse VisualEvent[] into people / tickets /
// handoffs / artifacts. The dashboard renders this object; it does not re-parse events.

import { resolveRole, roleLabel, parseRoleDirective, matchDirective, canonicalizeRole, roleFromAgentName } from "./roles.mjs";
import { parseHerdrAgentInvocation, parseHerdrCliJson } from "./herdr.mjs";

const LEAD = "lead";
const USER = "user";

const SUB_TOOLS = /^(Task|TaskCreate|spawn_subagent|subagent|Agent)$/i;
const NOISE_PROMPT = /^<(environment_context|turn_aborted)\b/i;
const STUB_PROMPT = /^(write|read|edit|search|delete|bash|ok|yes|no|continue|stop)$/i;

export function emptyOffice() {
  return {
    brief: "",
    briefs: [],
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
  const pendingHerdr = new Map();
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
      const raw = String(directive?.task || rawText).replace(/\s+/g, " ").trim();
      const title = oneLine(raw, 140);
      if (title) brief = title;
      const ticket = {
        id: `brief-${ev.id || tickets.length}`,
        title: title || "User brief",
        full: raw || title || "User brief",
        fromId: USER,
        toId: LEAD,
        status: "doing",
        startTs: ev.ts || "",
        endTs: null,
        durationMs: null,
      };
      closeTicket(openTicket.get(LEAD), ev.ts, "done");
      attachTicketResult(openTicket.get(LEAD), people.get(LEAD));
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

    if (ev.kind === "tool_call") {
      const inv = parseHerdrAgentInvocation(ev.detail || ev.label);
      if (inv) {
        pendingHerdr.set(ev.toolUseId || ev.id, inv);
        addEvent(LEAD, ev);
        bumpTool(LEAD, "herdr");
        continue;
      }
    }

    if ((ev.kind === "tool_output" || ev.kind === "tool_error") && pendingHerdr.has(ev.toolUseId)) {
      applyHerdrResult(ev, {
        people, tickets, handoffs, openTicket, openSubs, pendingHerdr,
        addEvent, bumpTool,
      });
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
      const full = String(ev.detail || ev.label || "").trim();
      const text = oneLine(full, 140);
      if (text && !isNoiseMessage(text)) {
        const p = people.get(pid);
        p.currentWork = text;
        if (pid === LEAD) outcome = text;
        const ticket = openTicket.get(pid);
        if (ticket) {
          ticket.result = oneLine(full, 200);
          ticket.resultFull = full;
        }
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

  attachTicketResult(openTicket.get(LEAD), people.get(LEAD));
  finalizeStatuses(people, { sawSessionEnd, openSubs, openTicket });
  applyRolesAndBelts(people, { toolsByPerson, filesByPerson, eventIdsByPerson, tickets });
  applyWorkSummaries(people, brief, outcome);
  applyLeadAssignments(people, tickets);
  stampRuntime(people, firstRuntime(events));

  const list = orderPeople(people);
  const artifacts = buildArtifacts(filesByPerson);
  return {
    brief,
    briefs: collectUserBriefs(tickets),
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

function herdrDeskId(name) {
  return `herdr:${String(name || "").trim().toLowerCase()}`;
}

function applyHerdrResult(ev, ctx) {
  const { people, tickets, handoffs, openTicket, openSubs, pendingHerdr, addEvent, bumpTool } = ctx;
  const inv = pendingHerdr.get(ev.toolUseId) || parseHerdrAgentInvocation(ev.detail);
  const parsed = parseHerdrCliJson(ev.detail);
  const failed = ev.kind === "tool_error" || Boolean(parsed?.error);
  const agent = parsed?.result?.agent || parsed?.agent || {};
  const name = String(agent.name || inv?.name || "").trim();
  pendingHerdr.delete(ev.toolUseId);
  if (!name || name.startsWith("-")) {
    addEvent(LEAD, ev);
    return;
  }

  const action = (() => {
    const id = String(parsed?.id || parsed?.result?.type || parsed?.type || "");
    if (id.includes("agent:start") || id === "agent_started") return "start";
    if (id.includes("agent:prompt") || id === "agent_prompted") return "prompt";
    return inv?.action || "";
  })();

  if (action === "start" && failed) {
    addEvent(LEAD, ev);
    return;
  }
  if (action !== "start" && action !== "prompt") {
    addEvent(LEAD, ev);
    return;
  }

  const id = herdrDeskId(name);
  const person = ensurePerson(people, id, "subagent");
  person.herdrName = name;
  const kind = inv?.kind || (typeof agent.agent === "string" ? agent.agent : "") || agent.kind || "";
  if (kind && kind !== "id") person.runtime = String(kind).toLowerCase();
  addEvent(LEAD, ev);
  addEvent(id, ev);

  if (action === "start") {
    if (!openSubs.includes(id)) openSubs.push(id);
    person.status = "doing";
    if (!person.currentWork) person.currentWork = `${name} started`;
    if (people.get(LEAD).status !== "blocked") people.get(LEAD).status = "doing";
    return;
  }

  const title = oneLine(inv?.text || agent.terminal_title_stripped || `prompt ${name}`, 80);
  const ticket = {
    id: `t-${id}-${tickets.length}`,
    title,
    full: inv?.text || title,
    fromId: LEAD,
    toId: id,
    status: "doing",
    startTs: ev.ts || "",
    endTs: null,
    durationMs: null,
  };
  tickets.push(ticket);
  openTicket.set(id, ticket);
  person.ticketId = ticket.id;
  person.currentWork = title;
  if (!openSubs.includes(id)) openSubs.push(id);
  handoffs.push(makeHandoff("delegate", LEAD, id, ticket.id, title, ev.ts));

  const st = String(agent.agent_status || agent.status || "").toLowerCase();
  if (failed || st === "blocked") {
    closeTicket(ticket, ev.ts, "failed");
    openTicket.delete(id);
    person.status = "blocked";
    person.errorCount += 1;
    handoffs.push(makeHandoff("return", id, LEAD, ticket.id, oneLine(ev.detail || "failed", 140), ev.ts));
    const idx = openSubs.lastIndexOf(id);
    if (idx >= 0) openSubs.splice(idx, 1);
    return;
  }
  if (st === "idle" || st === "done") {
    closeTicket(ticket, ev.ts, "done");
    openTicket.delete(id);
    person.status = "done";
    person.exited = st === "idle";
    handoffs.push(makeHandoff("return", id, LEAD, ticket.id, oneLine(title, 140), ev.ts));
    const idx = openSubs.lastIndexOf(id);
    if (idx >= 0) openSubs.splice(idx, 1);
    return;
  }
  person.status = "doing";
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
  const t = String(ev.label || ev.detail || "").trim();
  if (!t) return true;
  if (NOISE_PROMPT.test(t)) return true;
  if (STUB_PROMPT.test(t)) return true;
  return false;
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
    roleSource: kind === "lead" ? "lead" : "unmapped",
    status: "idle",
    currentWork: "",
    tasks: [],
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
    exited: false,
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
    p.tasks = (tickets || [])
      .filter((t) => t && t.toId === p.id && t.title)
      .map((t) => ({
        title: t.title,
        full: t.full || t.title,
        result: t.result || "",
        resultFull: t.resultFull || t.result || "",
        status: t.status || "",
        startTs: t.startTs || "",
        endTs: t.endTs || null,
      }));
    const resolved = resolveRole({ kind: p.kind, name: p.herdrName, hodRole: p.hodRole });
    p.roleHint = resolved.role;
    p.roleSource = resolved.roleSource;
    if (p.kind === "subagent") {
      if (p.herdrName) p.label = p.herdrName;
      else if (p.roleHint !== "unknown") p.label = roleLabel(p.roleHint);
    }
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
  const live = dedupeTeamMembers(members.filter((m) => m?.office && m?.meta));
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
    graph: mergeTeamGraphs(live),
  };
}

function linkEndId(value) {
  if (value && typeof value === "object") return String(value.id ?? "");
  return String(value ?? "");
}

function mergeTeamGraphs(members) {
  const nodes = [];
  const links = [];
  for (const m of members) {
    const sid = m.meta?.id;
    if (!sid) continue;
    const remap = new Map();
    for (const n of m.graph?.nodes || []) {
      if (!n?.id) continue;
      const nid = `${sid}:${n.id}`;
      remap.set(String(n.id), nid);
      nodes.push({ ...n, id: nid, sessionId: sid, eventId: n.id });
    }
    for (const l of m.graph?.links || []) {
      const source = remap.get(linkEndId(l.source));
      const target = remap.get(linkEndId(l.target));
      if (!source || !target) continue;
      links.push({ kind: l.kind, source, target });
    }
  }
  return { nodes, links };
}

/** One desk per live Herdr pane (or start-name). Keep the spawn's own session, not a newer chat. */
function dedupeTeamMembers(members) {
  const byKey = new Map();
  for (const m of members) {
    const pane = m.meta?.team?.paneId;
    const name = String(m.meta?.team?.herdrName || "").trim().toLowerCase();
    const rt = String(m.meta?.runtime || "");
    const key = pane
      ? `pane:${pane}`
      : name
        ? `name:${rt}:${name}`
        : `id:${m.meta.id}`;
    const prev = byKey.get(key);
    if (!prev || preferSpawnSession(m, prev)) byKey.set(key, m);
  }
  return [...byKey.values()];
}

function preferSpawnSession(next, prev) {
  const want = next.meta?.team?.herdrSessionId || prev.meta?.team?.herdrSessionId;
  if (want) {
    const nextHit = idsEqual(next.meta.id, want);
    const prevHit = idsEqual(prev.meta.id, want);
    if (nextHit !== prevHit) return nextHit;
  }
  return (next.meta.mtimeMs || 0) > (prev.meta.mtimeMs || 0);
}

function idsEqual(a, b) {
  if (!a || !b) return false;
  const x = String(a).toLowerCase();
  const y = String(b).toLowerCase();
  return x === y || x.endsWith(y) || y.endsWith(x);
}

function mergeTeamOffice(members) {
  const allDirectives = members.flatMap((m) => m.office?.directives || []);
  const leadMember = pickTeamLead(members, allDirectives);
  const workers = members.filter((m) => m.meta.id !== leadMember.meta.id);
  const src = leadMember.office || emptyOffice();
  const leadSrc = (src.people || []).find((p) => p.kind === "lead") || blankPerson(LEAD, "lead");
  // Herdr teammates are the floor. In-session Task subagents of the controller
  // would otherwise appear as extra desks next to the real worker/reviewer.

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
    exited: Boolean(leadMember.meta.team?.exited),
  };

  const staff = workers.map((w) => personFromMember(w, allDirectives));
  const people = [lead, ...staff];

  const tickets = [...(src.tickets || [])];
  const handoffs = [...(src.handoffs || [])];
  for (const w of workers) {
    const pid = herdrPersonId(w);
    const tasks = spawnTasks(w);
    tasks.forEach((task, i) => {
      const tid = `herdr-t-${w.meta.id}-${i}`;
      tickets.push({
        id: tid,
        title: task.title,
        fromId: LEAD,
        toId: pid,
        status: task.status || staffStatusToTicket(w),
        startTs: task.startTs || w.meta.startedAt || "",
        endTs: task.endTs || null,
        durationMs: null,
      });
      handoffs.push(makeHandoff("delegate", LEAD, pid, tid, task.title, task.startTs || w.meta.startedAt));
    });
    if (w.office.people?.[0]?.status === "done" || w.office.outcome) {
      const last = tasks[tasks.length - 1];
      handoffs.push(makeHandoff(
        "return",
        pid,
        LEAD,
        last ? `herdr-t-${w.meta.id}-${tasks.length - 1}` : `herdr-t-${w.meta.id}-0`,
        w.office.outcome || last?.title || "done",
        w.meta.mtimeMs ? new Date(w.meta.mtimeMs).toISOString() : "",
      ));
    }
  }

  const artifacts = mergeArtifacts([
    remapArtifacts(src.artifacts, LEAD),
    ...workers.map((w) => remapArtifacts(w.office.artifacts, herdrPersonId(w))),
  ]);

  const delegated = [...staff];
  lead.assignments = delegated.flatMap((p) => {
    const items = (p.tasks || []).length
      ? p.tasks
      : [{ title: p.currentWork, status: p.status }];
    return items.map((task) => ({
      who: assignmentWho(p),
      role: p.roleHint || "",
      task: oneLine(task.title || "", 160),
      full: task.full || task.title || "",
      result: oneLine(task.result || "", 200),
      resultFull: task.resultFull || task.result || "",
      status: task.status || p.status || "",
    })).filter((a) => a.task);
  });
  if (lead.assignments.length) {
    lead.currentWork = lead.assignments.map((a) => `${a.who}: ${a.task}`).join("\n");
  }

  return {
    brief: src.brief || workers.find((w) => w.office.brief)?.office.brief || "",
    briefs: collectUserBriefs(src.tickets),
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
  const hod = canonicalizeRole(member.meta?.team?.hodRole);
  if (hod) return { role: hod, source: "hod" };
  const directive = matchDirective(directives, {
    runtime: member.meta?.runtime,
    herdrName: member.meta?.team?.herdrName,
  });
  if (directive) return { role: directive.role, source: "user" };
  const named = roleFromAgentName(member.meta?.team?.herdrName);
  if (named) return { role: named, source: "name" };
  return null;
}

const CHILD_ROLES = new Set(["worker", "impl", "review", "advisor", "tester"]);

function childRoleOf(member) {
  const hod = canonicalizeRole(member.meta?.team?.hodRole);
  if (hod && CHILD_ROLES.has(hod)) return hod;
  const named = roleFromAgentName(member.meta?.team?.herdrName);
  if (named && CHILD_ROLES.has(named)) return named;
  return null;
}

function pickTeamLead(members, directives = []) {
  const byHod = members.find((m) => {
    const hod = String(m.meta?.team?.hodRole || "").toLowerCase();
    return hod === "controller" || hod === "lead";
  });
  if (byHod) return byHod;
  const byName = members.find((m) => roleFromAgentName(m.meta?.team?.herdrName) === "lead");
  if (byName) return byName;
  const byParent = members.find((m) => {
    const pane = m.meta?.team?.paneId;
    return pane && members.some((o) => o !== m && o.meta?.team?.hodParent === pane);
  });
  if (byParent) return byParent;
  // Untagged controller pane (Desktop 0.1.7): Claude with no start-name
  // sitting next to worker-1 / reviewer-1. Do not fall back to "started first".
  const children = members.filter((m) => childRoleOf(m));
  const rest = members.filter((m) => !childRoleOf(m));
  if (children.length && rest.length === 1) return rest[0];
  if (children.length && rest.length > 1) {
    const unnamed = rest.filter((m) => !String(m.meta?.team?.herdrName || "").trim());
    if (unnamed.length === 1) return unnamed[0];
    return [...rest].sort((a, b) => String(a.meta.startedAt || "").localeCompare(String(b.meta.startedAt || "")))[0];
  }
  const byAssign = members.find((m) => assignedRole(m, directives)?.role === "lead");
  if (byAssign) return byAssign;
  return [...members].sort((a, b) => String(a.meta.startedAt || "").localeCompare(String(b.meta.startedAt || "")))[0];
}

function personFromMember(member, directives = []) {
  const src = (member.office.people || []).find((p) => p.kind === "lead") || blankPerson(LEAD, "lead");
  const runtime = member.meta.runtime || "other";
  const assigned = assignedRole(member, directives);
  const spawn = String(member.meta.team?.herdrName || "").trim();
  const resolved = assigned || resolveRole({
    hodRole: member.meta.team?.hodRole,
    override: member.meta?.roleOverride,
    name: spawn,
  });
  return {
    ...src,
    id: herdrPersonId(member),
    kind: "subagent",
    label: spawn || (resolved.role !== "unknown" ? roleLabel(resolved.role) : shortId(member.meta.id)),
    roleHint: resolved.role,
    roleSource: resolved.source || resolved.roleSource,
    currentWork: spawnWorkText(member),
    tasks: spawnTasks(member),
    ticketId: `herdr-t-${member.meta.id}`,
    sessionId: member.meta.id,
    runtime,
    herdrName: spawn,
    exited: Boolean(member.meta.team?.exited),
    status: member.meta.team?.exited && src.status !== "blocked" ? "done" : src.status,
  };
}

function spawnTasks(member) {
  const briefs = (member.office?.tickets || [])
    .filter((t) => t && t.fromId === USER && t.title && !STUB_PROMPT.test(String(t.full || t.title).trim()))
    .map((t) => ({
      title: oneLine(t.full || t.title, 160),
      full: String(t.full || t.title || "").trim(),
      result: oneLine(t.resultFull || t.result || "", 200),
      resultFull: String(t.resultFull || t.result || "").trim(),
      status: t.status || "",
      startTs: t.startTs || "",
      endTs: t.endTs || null,
    }));
  if (briefs.length) return briefs;
  const title = spawnTaskTitle(member);
  const result = spawnWorkText(member);
  return title ? [{
    title,
    full: title,
    result: result && result !== title ? result : "",
    resultFull: result && result !== title ? result : "",
    status: staffStatusToTicket(member),
    startTs: member.meta?.startedAt || "",
    endTs: null,
  }] : [];
}

function attachTicketResult(ticket, person) {
  if (!ticket || ticket.result) return;
  const work = String(person?.currentWork || "").trim();
  if (!work || work === ticket.title) return;
  ticket.result = oneLine(work, 200);
  ticket.resultFull = work;
}

function collectUserBriefs(tickets = []) {
  const out = [];
  const seen = new Set();
  for (const t of tickets || []) {
    if (!t || t.fromId !== USER || !t.title) continue;
    const full = String(t.full || t.title || "").trim();
    if (STUB_PROMPT.test(full)) continue;
    const key = full.replace(/\s+/g, " ").toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      title: oneLine(full, 160),
      full,
      status: t.status || "",
    });
  }
  return out;
}

function spawnTaskTitle(member) {
  return oneLine(member.office?.brief || member.meta?.team?.hodTask || "", 140)
    || oneLine(member.office?.people?.[0]?.currentWork || "", 140)
    || "assigned work";
}

function spawnWorkText(member) {
  const outcome = oneLine(member.office?.outcome || "", 140);
  if (outcome) return outcome;
  const own = (member.office?.people || []).find((p) => p.kind === "lead");
  return oneLine(own?.currentWork || member.office?.brief || "", 140);
}

function herdrPersonId(member) {
  const spawn = String(member.meta?.team?.herdrName || "").trim().toLowerCase();
  const pane = member.meta?.team?.paneId;
  if (pane) return `herdr:pane:${pane}`;
  if (spawn) return `herdr:${member.meta.runtime}:${spawn}`;
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
