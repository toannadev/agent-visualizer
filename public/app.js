/* Agent Visualizer — vanilla JS (ported from React components).
   The server (realtime.mjs) computes graph/timeline/heatmap/messages; the client only renders them. */

(() => {
  "use strict";

  // ---------- helpers ----------
  const $ = (sel) => document.querySelector(sel);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  function fmtMs(n) {
    if (n == null) return "–";
    const s = Math.round(n / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}p${r}s`;
  }

  function fmtTokens(n) {
    if (n == null) return "0";
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
  }

  function parseTs(ts) {
    if (ts == null || ts === "") return null;
    if (typeof ts === "number" && Number.isFinite(ts)) {
      return new Date(ts < 1e12 ? ts * 1000 : ts);
    }
    const s = String(ts).trim();
    if (/^\d+(\.\d+)?$/.test(s)) {
      const n = Number(s);
      return new Date(n < 1e12 ? n * 1000 : n);
    }
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function fmtTime(ts) {
    const d = parseTs(ts);
    if (!d) return "–";
    return d.toLocaleString("vi-VN", {
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  }

  // ---------- state ----------
  const state = {
    sessions: [],
    detail: null,
    selectedId: null,
    tab: "sessions",
    runtimeFilter: "all",
    live: false,
    error: null,
    lastUpdated: null,
    busy: false,
    inspected: null,
    focusedPerson: null,
    es: null,
    pollTimer: null,
  };

  // ---------- fetch ----------
  async function api(path, opts) {
    const r = await fetch(path, opts);
    if (!r.ok) throw new Error(`${path} → ${r.status}`);
    return r.json();
  }

  async function loadSnapshot() {
    try {
      const j = await api("/api/v1/sessions");
      state.sessions = j.sessions || [];
      state.error = null;
      state.lastUpdated = Date.now();
      if (!state.selectedId) {
        const running = j.sessions.find((s) => s.meta?.status === "running");
        state.selectedId = running?.meta?.id || j.sessions?.[0]?.meta?.id || null;
      }
      renderAll();
    } catch (e) {
      state.error = "Cannot reach the realtime server. Run: npx visualizer";
      renderAll();
    }
  }

  async function loadDetail(id) {
    try {
      const j = await api(`/api/v1/sessions/${encodeURIComponent(id)}`);
      state.detail = j.session || null;
      state.lastUpdated = Date.now();
      renderAll();
    } catch { /* Keep the previous detail view. */ }
  }

  async function replay(runtime, filePath) {
    const j = await api("/api/v1/watch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runtime, path: filePath }),
    });
    if (j.id) {
      state.selectedId = j.id;
      await loadDetail(j.id);
      await loadSnapshot();
    }
    return j;
  }

  // ---------- SSE + poll ----------
  function setupSSE() {
    if (state.es) state.es.close();
    try {
      const es = new EventSource(`${location.origin}/api/v1/stream`);
      state.es = es;
      es.addEventListener("health", () => { state.live = true; renderTopbar(); });
      es.addEventListener("session.upsert", (e) => {
        state.live = true;
        const d = JSON.parse(e.data);
        const idx = state.sessions.findIndex((s) => s?.meta?.id === d.id);
        const summary = { meta: d.meta, metrics: d.metrics, officeCounts: d.officeCounts || null };
        if (idx >= 0) state.sessions[idx] = summary;
        else state.sessions.unshift(summary);
        if (state.selectedId === d.id) loadDetail(d.id);
        renderAll();
      });
      es.addEventListener("session.gone", (e) => {
        const d = JSON.parse(e.data);
        state.sessions = state.sessions.filter((s) => s?.meta?.id !== d.id);
        if (state.selectedId === d.id) { state.selectedId = null; state.detail = null; }
        renderAll();
      });
      es.onerror = () => { state.live = false; setupPoll(); };
    } catch {
      state.live = false;
      setupPoll();
    }
  }

  function setupPoll() {
    if (state.pollTimer) return;
    state.pollTimer = setInterval(() => {
      if (state.live) { clearInterval(state.pollTimer); state.pollTimer = null; return; }
      loadSnapshot();
      if (state.selectedId) loadDetail(state.selectedId);
    }, 4000);
  }

  // ---------- render ----------
  function renderAll() {
    renderTopbar();
    renderSidebar();
    renderDetail();
    renderReplay();
    renderInspector();
  }

  function renderTopbar() {
    const n = state.sessions.length;
    $("#session-count").textContent = `${n} session`;
    const live = $("#rt-live");
    live.hidden = !state.live;
    const err = $("#rt-error");
    err.hidden = !state.error;
    err.textContent = state.error || "";
    const upd = $("#rt-updated");
    upd.hidden = !state.lastUpdated;
    if (state.lastUpdated) upd.textContent = `updated ${new Date(state.lastUpdated).toLocaleTimeString()}`;
  }

  // ---------- sidebar ----------
  function matchesRuntime(s) {
    return state.runtimeFilter === "all" || s?.meta?.runtime === state.runtimeFilter;
  }

  function renderSidebar() {
    const box = $("#sidebar");
    box.innerHTML = "";
    const filterRow = el("div", "rt-filter");
    for (const f of ["all", "claude", "codex", "grok"]) {
      const label = f === "all" ? "All" : f;
      const b = el("button", `rt-tab ${state.runtimeFilter === f ? "active" : ""}`, label);
      b.onclick = () => { state.runtimeFilter = f; renderSidebar(); };
      filterRow.appendChild(b);
    }
    box.appendChild(filterRow);

    const { groups, loose } = groupSessions(state.sessions);
    const shownGroups = groups.filter((g) => g.members.some(matchesRuntime));
    const shownLoose = loose.filter(matchesRuntime);
    if (!shownGroups.length && !shownLoose.length) {
      box.appendChild(el("div", "empty", "No sessions."));
    }
    for (const g of shownGroups) box.appendChild(renderTeamItem(g));
    for (const s of shownLoose) box.appendChild(renderSessionItem(s));
  }

  function groupSessions(list) {
    const byTeam = new Map();
    const loose = [];
    for (const s of list) {
      const tid = s?.meta?.team?.id;
      if (!tid) { loose.push(s); continue; }
      if (!byTeam.has(tid)) byTeam.set(tid, []);
      byTeam.get(tid).push(s);
    }
    const groups = [];
    for (const [, members] of byTeam) {
      if (members.length >= 2) {
        members.sort((a, b) => (b.meta?.mtimeMs || 0) - (a.meta?.mtimeMs || 0));
        groups.push({
          id: members[0].meta.team.id,
          label: members[0].meta.team.label || "team",
          members,
        });
      } else {
        loose.push(members[0]);
      }
    }
    groups.sort((a, b) => maxMtime(b.members) - maxMtime(a.members));
    loose.sort((a, b) => (b.meta?.mtimeMs || 0) - (a.meta?.mtimeMs || 0));
    return { groups, loose };
  }

  function maxMtime(members) {
    return Math.max(0, ...members.map((s) => s.meta?.mtimeMs || 0));
  }

  function selectSession(id) {
    if (state.selectedId !== id) {
      state.focusedPerson = null;
      state.inspected = null;
    }
    state.selectedId = id;
    loadDetail(id);
  }

  function startRoleOf(s) {
    const hod = String(s?.meta?.team?.hodRole || "").toLowerCase();
    if (hod === "controller" || hod === "lead") return "lead";
    if (hod === "reviewer") return "review";
    if (hod === "worker" || hod === "advisor" || hod === "tester") return hod;
    const name = String(s?.meta?.team?.herdrName || "").toLowerCase();
    for (const part of name.split(/[-_]+/).filter(Boolean)) {
      if (part === "lead" || part === "controller") return "lead";
      if (part === "reviewer") return "review";
      if (part === "impl" || part === "implementer") return "impl";
      if (part === "worker" || part === "advisor" || part === "tester") return part;
    }
    return "";
  }

  function teamLeadSession(members) {
    const list = members || [];
    const byOverride = list.find((s) => s.meta?.roleOverride === "lead");
    if (byOverride) return byOverride;
    const byHod = list.find((s) => {
      const hod = s.meta?.team?.hodRole;
      return hod === "controller" || hod === "lead";
    });
    if (byHod) return byHod;
    const byName = list.find((s) => startRoleOf(s) === "lead");
    if (byName) return byName;
    const byParent = list.find((s) => {
      const pane = s.meta?.team?.paneId;
      return pane && list.some((o) => o !== s && o.meta?.team?.hodParent === pane);
    });
    if (byParent) return byParent;
    const rest = list.filter((s) => {
      const role = startRoleOf(s);
      return !role || role === "lead";
    });
    if (rest.length && rest.length < list.length) return rest[0];
    return list[0];
  }

  function renderTeamItem(g) {
    const members = g.members;
    const lead = teamLeadSession(members);
    const selected = members.some((s) => s.meta?.id === state.selectedId);
    const item = el("div", `session-item session-team${selected ? " active" : ""}`);
    item.onclick = () => selectSession(lead?.meta?.id);
    const top = el("div", "s-top");
    top.appendChild(el("span", "rt-badge herdr", "herdr"));
    const runtimes = [...new Set(members.map((s) => s.meta?.runtime).filter(Boolean))];
    for (const rt of runtimes) top.appendChild(el("span", `rt-badge ${rt}`, rt));
    const statuses = members.map((s) => s.meta?.status);
    const status = statuses.includes("running") ? "running" : statuses.includes("error") ? "error" : (lead?.meta?.status || "idle");
    const badge = el("span", `badge ${status}`);
    const dot = el("span", "dot");
    dot.style.background = status === "running" ? "var(--green)" : "var(--muted)";
    badge.appendChild(dot);
    badge.appendChild(document.createTextNode(status));
    top.appendChild(badge);
    top.appendChild(el("div", "s-title", g.label || "team"));
    item.appendChild(top);
    const meta = el("div", "s-meta");
    meta.appendChild(el("span", "", `${members.length} agents`));
    const names = [...new Set(members.map((s) => s.meta?.team?.herdrName).filter(Boolean))];
    if (names.length) meta.appendChild(el("span", "", names.join(", ")));
    const tools = members.reduce((n, s) => n + (s.metrics?.toolCount || 0), 0);
    meta.appendChild(el("span", "", `${tools} tool`));
    meta.appendChild(el("span", "", fmtTime(maxMtime(members))));
    item.appendChild(meta);
    return item;
  }

  function renderSessionItem(s) {
    const m = s?.meta;
    if (!m) return el("div");
    const item = el("div", `session-item${m.id === state.selectedId ? " active" : ""}`);
    item.onclick = () => selectSession(m.id);
    const top = el("div", "s-top");
    if (m.team) top.appendChild(el("span", "rt-badge herdr", "herdr"));
    if (m.runtime) top.appendChild(el("span", `rt-badge ${m.runtime}`, m.runtime));
    const badge = el("span", `badge ${m.status}`);
    const dot = el("span", "dot");
    dot.style.background = m.status === "running" ? "var(--green)" : "var(--muted)";
    badge.appendChild(dot);
    badge.appendChild(document.createTextNode(m.status));
    top.appendChild(badge);
    top.appendChild(el("div", "s-title", m.title || m.cwd || m.projectDir || m.id));
    item.appendChild(top);
    const meta = el("div", "s-meta");
    meta.appendChild(el("span", "", `${s.metrics?.toolCount ?? 0} tool`));
    if (s.officeCounts?.doing) meta.appendChild(el("span", "", `${s.officeCounts.doing} doing`));
    meta.appendChild(el("span", "", fmtTime(m.mtimeMs)));
    if (m.model) meta.appendChild(el("span", "", m.model));
    item.appendChild(meta);
    return item;
  }

  // ---------- detail ----------
  function renderDetail() {
    const wrap = $("#detail");
    if (state.tab !== "sessions" || !state.detail) {
      if (state.tab === "sessions" && !state.detail && !state.error) {
        wrap.innerHTML = `<div class="empty">Select a session from the sidebar…</div>`;
      }
      return;
    }
    const s = state.detail;
    const m = s.meta, met = s.metrics;
    refreshInspected(s.office);

    const head = el("div", "detail-head");
    const hLeft = el("div");
    const h2 = el("h2");
    h2.appendChild(document.createTextNode(`${m.title || m.cwd || m.projectDir || m.id} `));
    const badge = el("span", `badge ${m.status}`);
    const dot = el("span", "dot");
    dot.style.background = m.status === "running" ? "var(--green)" : "var(--muted)";
    badge.appendChild(dot);
    badge.appendChild(document.createTextNode(m.status));
    h2.appendChild(badge);
    hLeft.appendChild(h2);
    hLeft.appendChild(el("div", "sub", `${m.id} · ${m.source} · ${m.path || "no path"}`));
    head.appendChild(hLeft);

    const stats = el("div", "stat-row");
    const stat = (value, suffix) => {
      const span = el("span");
      const strong = el("b", "", String(value));
      span.appendChild(strong);
      if (suffix) span.appendChild(document.createTextNode(` ${suffix}`));
      return span;
    };
    stats.appendChild(stat(met.toolCount, "tool"));
    stats.appendChild(stat(fmtTokens(met.tokenTotal), "token"));
    stats.appendChild(stat(fmtMs(met.durationMs), ""));
    stats.appendChild(stat(met.fileCount, "files"));
    const errSpan = stat(met.errorCount, "errors");
    if (met.errorCount) errSpan.style.color = "var(--red)";
    stats.appendChild(errSpan);
    head.appendChild(stats);
    wrap.innerHTML = "";
    wrap.appendChild(head);

    const grid = el("div", "v-main-grid");
    const mkPanel = (title, className = "") => {
      const p = el("div", `v-panel-wrap${className ? ` ${className}` : ""}`);
      p.appendChild(el("div", "v-panel-title", title));
      const body = el("div", className ? `${className}-body` : "");
      p.appendChild(body);
      grid.appendChild(p);
      return body;
    };

    const officeBox = mkPanel(officePanelTitle(s.office), "office-panel");
    const graphBox = mkPanel(
      state.focusedPerson
        ? `Forensics · Execution Graph · ${personLabel(officePerson(s.office, state.focusedPerson))}`
        : "Forensics · Execution Graph",
      "graph-panel",
    );
    const heatTitle = state.focusedPerson
      ? `Files · ${personLabel(officePerson(s.office, state.focusedPerson))}`
      : "Files";
    const heatBox = mkPanel(heatTitle);
    const msgBox = mkPanel(`Messages (${s.messages.length})`);
    wrap.appendChild(grid);

    renderOffice(officeBox, s.office);
    const files = focusedFiles(s.office, s.heatmap);
    renderHeatmap(heatBox, files, { filtered: Boolean(state.focusedPerson) });
    renderMessageLog(msgBox, s.messages);
    try {
      renderGraph(graphBox, s.graph, { compact: true });
    } catch (err) {
      console.error("Graph render failed", err);
      renderStaticGraph(graphBox, s.graph);
    }
  }

  function officePanelTitle(office) {
    if (!office) return "Office";
    const c = office.counts || {};
    const bits = [];
    if (office.teamLabel) bits.push(office.teamLabel);
    bits.push(`${c.people || 1} people`);
    if (c.doing) bits.push(`${c.doing} doing`);
    if (c.blocked) bits.push(`${c.blocked} blocked`);
    return `Office · ${bits.join(" · ")}`;
  }

  function officePerson(office, id) {
    return (office?.people || []).find((p) => p.id === id) || null;
  }

  function personRuntime(p) {
    if (p?.runtime) return p.runtime;
    if (p?.kind === "lead") return state.detail?.meta?.runtime || "";
    return "";
  }

  function prettyRuntime(runtime) {
    const rt = String(runtime || "").toLowerCase();
    if (rt === "claude") return "Claude";
    if (rt === "codex") return "Codex";
    if (rt === "grok") return "Grok";
    if (!rt || rt === "other") return "";
    return rt.charAt(0).toUpperCase() + rt.slice(1);
  }

  function isRuntimeEcho(text, runtime) {
    const a = String(text || "").trim().toLowerCase();
    if (!a) return false;
    const rt = String(runtime || "").trim().toLowerCase();
    const pretty = prettyRuntime(runtime).toLowerCase();
    return a === rt || (pretty && a === pretty);
  }

  function spawnName(p) {
    const name = String(p?.herdrName || "").trim();
    if (!name || isRuntimeEcho(name, personRuntime(p))) return "";
    return name;
  }

  function personLabel(p) {
    return spawnName(p) || roleBadgeText(p) || p?.label || p?.id || "desk";
  }

  function displayWork(text) {
    return String(text || "")
      .replace(/\*\*(.*?)\*\*/g, "$1")
      .replace(/^#+\s+/gm, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function focusedFiles(office, heatmap) {
    if (!state.focusedPerson || !office?.artifacts) return heatmap || [];
    const person = officePerson(office, state.focusedPerson);
    const allowed = new Set((person?.files || []).map((f) => f.path));
    return (heatmap || []).filter((f) => allowed.has(f.path));
  }

  function refreshInspected(office) {
    const node = state.inspected;
    if (!node || !office) return;
    if (node.inspect === "person") {
      const fresh = officePerson(office, node.id);
      state.inspected = fresh ? { inspect: "person", ...fresh } : null;
    } else if (node.inspect === "artifact") {
      const fresh = (office.artifacts || []).find((a) => a.path === node.path);
      state.inspected = fresh ? { inspect: "artifact", ...fresh } : node;
    }
  }

  function clearOfficeFocus() {
    state.focusedPerson = null;
    if (state.inspected?.inspect === "person" || state.inspected?.inspect === "artifact") {
      state.inspected = null;
    }
    renderAll();
  }

  function focusPerson(person) {
    state.focusedPerson = person.id;
    state.inspected = { inspect: "person", ...person };
    renderAll();
  }

  function inspectArtifact(art) {
    state.inspected = { inspect: "artifact", status: "idle", kind: "artifact", ...art };
    renderInspector();
  }

  // ---------- office floor ----------
  function renderOffice(box, office) {
    box.innerHTML = "";
    if (!office) {
      box.appendChild(el("div", "empty", "Waiting for the first prompt…"));
      return;
    }
    const people = office.people || [];
    const lead = people.find((p) => p.kind === "lead") || people[0];
    const subs = people.filter((p) => p.kind === "subagent");

    const root = el("div", "office");
    root.addEventListener("click", (evt) => {
      if (evt.target === root || evt.target.classList.contains("office-floor")) clearOfficeFocus();
    });

    if (state.focusedPerson) {
      const bar = el("div", "office-focus-bar");
      bar.appendChild(el("span", "", `Focused: ${personLabel(officePerson(office, state.focusedPerson))}`));
      const clear = el("button", "btn", "Show all");
      clear.addEventListener("click", (evt) => { evt.stopPropagation(); clearOfficeFocus(); });
      bar.appendChild(clear);
      root.appendChild(bar);
    }

    if (!people.length || (people.length === 1 && !lead?.ticketId && !lead?.toolCount && !office.brief)) {
      root.appendChild(el("div", "empty", "Waiting for the first prompt…"));
    }

    const floor = el("div", "office-floor");

    const userNode = el("div", "office-node");
    userNode.appendChild(renderUserCard(office.brief));

    if (lead) {
      const leadNode = el("div", "office-node");
      leadNode.appendChild(renderDesk(lead));
      if (subs.length) {
        leadNode.appendChild(renderKids("assign", staffConnectFlow(subs), subs));
      }
      userNode.appendChild(renderKids("assign", deskBusy(lead) ? "down" : "up", [leadNode]));
    }

    floor.appendChild(userNode);
    root.appendChild(floor);
    box.appendChild(root);
    requestAnimationFrame(() => layoutOfficeRails(root));
  }

  const SPARK_MS = 1600;

  function deskBusy(person) {
    return person?.status === "doing" || person?.status === "blocked";
  }

  function staffConnectFlow(people) {
    const busy = people.some(deskBusy);
    const returned = people.some((p) => p.status === "done");
    if (busy && returned) return "both";
    if (busy) return "down";
    if (returned) return "up";
    return "down";
  }

  function sparkPhase(salt) {
    let n = 0;
    for (const ch of String(salt || "")) n += ch.charCodeAt(0);
    return (Date.now() + n * 420) % SPARK_MS;
  }

  function addSparks(node, flow, salt, kind) {
    const extra = kind ? ` office-spark-${kind}` : "";
    const shift = kind === "rail" ? SPARK_MS / 3 : kind === "drop" ? (2 * SPARK_MS) / 3 : 0;
    const phase = (sparkPhase(salt) + shift) % SPARK_MS;
    if (flow === "down" || flow === "both") {
      const spark = el("span", `office-spark office-spark-down${extra}`);
      spark.style.animationDelay = `${-phase}ms`;
      node.appendChild(spark);
    }
    if (flow === "up" || flow === "both") {
      const spark = el("span", `office-spark office-spark-up${extra}`);
      spark.style.animationDelay = `${-((phase + SPARK_MS / 2) % SPARK_MS)}ms`;
      node.appendChild(spark);
    }
  }

  function layoutOfficeRails(root) {
    for (const box of root.querySelectorAll(".office-kids.is-fork")) {
      const nodes = [...box.querySelectorAll(":scope > .office-node")];
      const jr = box.getBoundingClientRect();
      const junctionX = jr.left + jr.width / 2;
      for (const node of nodes) {
        const r = node.getBoundingClientRect();
        const dx = r.left + r.width / 2 - junctionX;
        node.style.setProperty("--rail-dx", `${dx}px`);
        const hide = Math.abs(dx) < 8;
        for (const spark of node.querySelectorAll(":scope > .office-spark-rail")) {
          spark.style.display = hide ? "none" : "";
        }
      }
    }
  }

  function renderKids(label, flow, items) {
    const fork = items.length > 1;
    const box = el("div", `office-kids${flow ? ` is-flow-${flow}` : ""}${fork ? " is-fork" : ""}`);
    if (label) box.appendChild(el("span", "office-connect-tag", label));
    addSparks(box, flow, label, "stem");
    items.forEach((item, i) => {
      let node = item;
      if (!(item instanceof HTMLElement)) {
        node = el("div", "office-node");
        node.appendChild(renderDesk(item));
      }
      if (fork) {
        addSparks(node, flow, `${label}-rail-${i}`, "rail");
        addSparks(node, flow, `${label}-${i}`, "drop");
      }
      box.appendChild(node);
    });
    return box;
  }

  function renderUserCard(brief) {
    const card = el("div", "office-desk office-desk-user");
    const top = el("div", "office-desk-top");
    top.appendChild(el("span", "office-desk-name", "User"));
    card.appendChild(top);
    card.appendChild(el("div", "office-desk-work", displayWork(brief) || "asked"));
    return card;
  }

  function renderDesk(person) {
    const selected = state.focusedPerson === person.id ? " is-selected" : "";
    const card = el("button", `office-desk office-desk-${person.kind}${selected}`);
    card.type = "button";
    card.addEventListener("click", (evt) => {
      evt.stopPropagation();
      if (state.focusedPerson === person.id && state.inspected?.inspect === "person") {
        clearOfficeFocus();
      } else {
        focusPerson(person);
      }
    });

    const top = el("div", "office-desk-top");
    const lamp = el("span", `office-lamp ${person.status}`);
    top.appendChild(lamp);
    const runtime = personRuntime(person);
    if (runtime) top.appendChild(el("span", `rt-badge ${runtime}`, runtime));
    const spawn = spawnName(person);
    if (spawn) top.appendChild(el("span", "office-desk-name", spawn));
    const role = effectiveRole(person);
    const roleBadge = roleBadgeText(person);
    if (roleBadge) top.appendChild(el("span", `office-role role-${role}`, roleBadge));
    card.appendChild(top);

    const assigns = person.kind === "lead" ? (person.assignments || []) : [];
    if (assigns.length) {
      const list = el("div", "office-assigns");
      for (const a of assigns) {
        const row = el("div", `office-assign ${a.status || ""}`);
        row.appendChild(el("span", "office-assign-who", a.who || "agent"));
        row.appendChild(el("span", "office-assign-task", displayWork(a.task) || ""));
        list.appendChild(row);
      }
      card.appendChild(list);
    } else {
      card.appendChild(el("div", "office-desk-work", displayWork(person.currentWork) || "Idle"));
    }

    if (person.errorCount) {
      card.appendChild(el("div", "office-desk-meta office-err", `${person.errorCount} err`));
    }
    card.classList.add(`office-desk-role-${role}`);
    return card;
  }

  function effectiveRole(person) {
    const role = person?.roleHint;
    if (role && role !== "unknown") return role;
    if (person?.kind === "lead") return "lead";
    return "unknown";
  }

  function roleBadgeText(person) {
    const labels = {
      lead: "Lead",
      worker: "Worker",
      impl: "Impl",
      review: "Reviewer",
      advisor: "Advisor",
      tester: "Tester",
      unknown: "Unmapped",
    };
    const role = effectiveRole(person);
    return labels[role] || "";
  }



  // ---------- graph (d3-force layout) ----------
  const KIND_COLOR = {
    session_root: "#58a6ff", user_prompt: "#d2a8ff", reasoning: "#ffa657",
    agent_message: "#3fb950", tool_call: "#79c0ff", tool_output: "#3fb950",
    subagent_start: "#f778ba", subagent_stop: "#f778ba", session_end: "#8b949e", error: "#f85149",
  };
  let graphSim = null;

  function graphNodeId(value) {
    return typeof value === "object" ? value?.id : value;
  }

  function clipLabel(text, max = 42) {
    const s = String(text || "").replace(/\s+/g, " ").trim();
    if (!s) return "";
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
  }

  function fileBase(node) {
    const path = node?.filePaths?.[0]?.path || "";
    if (!path) return "";
    const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    return i >= 0 ? path.slice(i + 1) : path;
  }

  function isGraphNoise(node) {
    const label = String(node.label || "").trim();
    if (node.kind === "agent_message") {
      if (label === "▶ turn started" || label === "complete") return true;
      if (label.startsWith("⏹ turn aborted")) return true;
    }
    if (node.kind === "user_prompt" && /^<(environment_context|turn_aborted)\b/i.test(label)) return true;
    return false;
  }

  // Story graph: one prompt → grouped tools → one reply. Hides chatter.
  function simplifyGraph(graph) {
    const raw = [...(graph?.nodes || [])]
      .filter((node) => node.kind !== "session_root" || node.id === "root")
      .filter((node) => !isGraphNoise(node))
      .sort((a, b) => String(a.ts || "").localeCompare(String(b.ts || "")));

    const nodes = [];
    const links = [];
    const add = (node) => { nodes.push(node); return node; };
    const connect = (source, target, kind = "flow") => {
      if (!source || !target || source === target) return;
      links.push({ source, target, kind });
    };

    const rootSrc = raw.find((n) => n.id === "root") || { id: "root", ts: raw[0]?.ts };
    const root = add({
      ...rootSrc,
      id: "root",
      kind: "session_root",
      label: "Start",
    });

    let prompt = root;
    const buckets = new Map();
    let lastReply = null;

    const flushTools = () => {
      const rows = [...buckets.values()]
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);
      for (const row of rows) {
        const file = row.file && row.count === 1 ? ` ${row.file}` : "";
        const count = row.count > 1 ? ` ×${row.count}` : "";
        const node = add({
          id: `story-tool:${prompt.id}:${row.name}`,
          kind: row.error ? "error" : "tool_call",
          label: `${row.name}${file}${count}`,
          toolName: row.name,
          ts: row.ts,
          status: row.error ? "error" : "completed",
          eventIds: row.ids,
        });
        connect(prompt.id, node.id, "tool");
      }
      buckets.clear();
    };

    const flushReply = () => {
      if (!lastReply || prompt.id === "root") { lastReply = null; return; }
      const node = add({
        ...lastReply,
        id: `story-reply:${prompt.id}`,
        kind: "agent_message",
        label: clipLabel(lastReply.detail || lastReply.label, 48) || "Reply",
      });
      connect(prompt.id, node.id, "reply");
      lastReply = null;
    };

    for (const src of raw) {
      if (src.kind === "session_root" || src.id === "root") continue;
      if (src.kind === "user_prompt") {
        flushTools();
        flushReply();
        prompt = add({
          ...src,
          label: clipLabel(src.detail || src.label, 48) || "Prompt",
        });
        connect(root.id, prompt.id, "turn");
        continue;
      }
      if (src.kind === "tool_call") {
        const name = src.toolName || "tool";
        const rec = buckets.get(name) || { name, count: 0, file: "", ts: src.ts, error: false, ids: [] };
        rec.count += 1;
        rec.file = rec.file || fileBase(src);
        rec.ids.push(src.id);
        buckets.set(name, rec);
        continue;
      }
      if (src.kind === "error" || src.kind === "tool_error") {
        const name = src.toolName || "error";
        const rec = buckets.get(name) || { name, count: 0, file: "", ts: src.ts, error: true, ids: [] };
        rec.count += 1;
        rec.error = true;
        rec.ids.push(src.id);
        buckets.set(name, rec);
        continue;
      }
      if (src.kind === "subagent_start") {
        flushTools();
        const node = add({
          ...src,
          label: clipLabel(src.label || src.agentId || "Subagent", 36),
        });
        connect(prompt.id, node.id, "parent");
        continue;
      }
      if (src.kind === "agent_message") lastReply = src;
    }
    flushTools();
    flushReply();
    return { nodes, links };
  }

  function layoutStory(nodes, links, width) {
    const kids = new Map();
    for (const n of nodes) kids.set(n.id, []);
    for (const l of links) {
      const s = graphNodeId(l.source);
      const t = graphNodeId(l.target);
      if (kids.has(s)) kids.get(s).push(t);
    }
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const root = byId.get("root") || nodes[0];
    const col = Math.max(280, width - 48);
    let y = 36;
    if (root) {
      root.x = width / 2;
      root.y = y;
      y += 72;
    }
    const prompts = (kids.get(root?.id) || []).map((id) => byId.get(id)).filter(Boolean);
    for (const prompt of prompts) {
      prompt.x = width / 2;
      prompt.y = y;
      y += 58;
      const children = (kids.get(prompt.id) || []).map((id) => byId.get(id)).filter(Boolean);
      const tools = children.filter((n) => n.kind === "tool_call" || n.kind === "error" || n.kind === "subagent_start");
      const replies = children.filter((n) => n.kind === "agent_message");
      if (tools.length) {
        const gap = Math.min(168, Math.max(110, col / Math.max(tools.length, 1)));
        tools.forEach((n, i) => {
          n.x = width / 2 + (i - (tools.length - 1) / 2) * gap;
          n.y = y;
        });
        y += 58;
      }
      for (const reply of replies) {
        reply.x = width / 2;
        reply.y = y;
        y += 64;
      }
    }
    return Math.max(280, y + 24);
  }

  function addGraphLegend(box) {
    const legend = el("div", "graph-legend");
    const items = [
      ["session_root", "Start"], ["user_prompt", "Prompt"], ["tool_call", "Tool"],
      ["agent_message", "Reply"], ["subagent_start", "Subagent"], ["error", "Error"],
    ];
    for (const [kind, label] of items) {
      const item = el("span", "graph-legend-item");
      const dot = el("span", "graph-legend-dot");
      dot.style.background = KIND_COLOR[kind];
      item.appendChild(dot);
      item.appendChild(document.createTextNode(label));
      legend.appendChild(item);
    }
    legend.appendChild(el("span", "graph-legend-note", "Prompt → tools → reply"));
    box.appendChild(legend);
  }

  function renderGraph(box, graph, opts = {}) {
    renderStoryGraph(box, graph, opts);
  }

  function renderStoryGraph(box, graph, opts = {}) {
    box.innerHTML = "";
    if (graphSim) { graphSim.stop(); graphSim = null; }
    const displayGraph = simplifyGraph(graph);
    addGraphLegend(box);
    const wrap = el("div", `graph-wrap${opts.compact ? " graph-wrap-forensics" : ""}`);
    box.appendChild(wrap);
    if (!displayGraph.nodes.length) { wrap.appendChild(el("div", "empty", "No data.")); return; }

    const width = Math.max(420, wrap.clientWidth || 640);
    const height = layoutStory(displayGraph.nodes, displayGraph.links, width);
    const focusIds = focusedEventIds();
    const byId = new Map(displayGraph.nodes.map((n) => [n.id, n]));
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    wrap.appendChild(svg);

    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    svg.appendChild(g);
    let zoom = 1, panX = 0, panY = 0, panState = null;
    const applyTransform = () => g.setAttribute("transform", `translate(${panX} ${panY}) scale(${zoom})`);
    svg.addEventListener("wheel", (evt) => {
      evt.preventDefault();
      zoom = Math.min(2.4, Math.max(0.45, zoom * (evt.deltaY < 0 ? 1.08 : 0.92)));
      applyTransform();
    }, { passive: false });
    svg.addEventListener("pointerdown", (evt) => {
      if (evt.target !== svg) return;
      panState = { x: evt.clientX, y: evt.clientY, panX, panY };
      svg.setPointerCapture?.(evt.pointerId);
    });
    svg.addEventListener("pointermove", (evt) => {
      if (!panState) return;
      panX = panState.panX + evt.clientX - panState.x;
      panY = panState.panY + evt.clientY - panState.y;
      applyTransform();
    });
    svg.addEventListener("pointerup", (evt) => {
      panState = null;
      svg.releasePointerCapture?.(evt.pointerId);
    });

    for (const link of displayGraph.links) {
      const source = byId.get(graphNodeId(link.source));
      const target = byId.get(graphNodeId(link.target));
      if (!source || !target) continue;
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.classList.add("g-link");
      line.setAttribute("x1", String(source.x));
      line.setAttribute("y1", String(source.y));
      line.setAttribute("x2", String(target.x));
      line.setAttribute("y2", String(target.y));
      g.appendChild(line);
    }

    for (const n of displayGraph.nodes) {
      const gn = document.createElementNS("http://www.w3.org/2000/svg", "g");
      gn.classList.add("g-node");
      if (focusIds && !nodeBelongsToFocus(n, focusIds)) gn.classList.add("is-dim");
      const label = n.label || n.id;
      const w = Math.min(280, Math.max(72, 14 + label.length * 7.1));
      const h = n.kind === "user_prompt" || n.kind === "agent_message" ? 28 : 24;
      const pill = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      pill.setAttribute("x", String(-w / 2));
      pill.setAttribute("y", String(-h / 2));
      pill.setAttribute("width", String(w));
      pill.setAttribute("height", String(h));
      pill.setAttribute("rx", "12");
      pill.setAttribute("fill", KIND_COLOR[n.kind] || "#8b949e");
      pill.setAttribute("fill-opacity", n.kind === "session_root" ? "0.95" : "0.22");
      pill.setAttribute("stroke", KIND_COLOR[n.kind] || "#8b949e");
      pill.setAttribute("stroke-width", n.kind === "error" ? "1.6" : "1");
      const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
      t.setAttribute("text-anchor", "middle");
      t.setAttribute("y", "4");
      t.textContent = label;
      gn.appendChild(pill);
      gn.appendChild(t);
      gn.setAttribute("transform", `translate(${n.x} ${n.y})`);
      gn.addEventListener("pointerup", (evt) => {
        if (evt.detail > 1) return;
        state.inspected = n;
        renderInspector();
      });
      g.appendChild(gn);
    }
  }

  function focusedEventIds() {
    if (!state.focusedPerson) return null;
    const person = officePerson(state.detail?.office, state.focusedPerson);
    return person?.eventIds?.length ? new Set(person.eventIds) : new Set();
  }

  function nodeBelongsToFocus(node, focusIds) {
    if (!focusIds) return true;
    if (node.kind === "session_root") return true;
    if (focusIds.has(node.id)) return true;
    if (node.eventIds?.some((id) => focusIds.has(id))) return true;
    if (state.focusedPerson === "lead" && node.kind === "user_prompt") return true;
    if (node.agentId && node.agentId === state.focusedPerson) return true;
    return false;
  }
  function renderStaticGraph(box, graph) {
    renderStoryGraph(box, graph, {});
  }

  // ---------- heatmap ----------
  function renderHeatmap(box, files, opts = {}) {
    if (!files?.length) {
      box.innerHTML = `<div class="empty">${opts.filtered ? "No files attributed to this desk." : "No files accessed."}</div>`;
      return;
    }
    const max = Math.max(1, ...files.map((f) => f.total));
    const heat = el("div", "heat");
    for (const f of files.slice(0, 60)) {
      const row = el("div", "heat-row");
      const pathEl = el("span", "heat-path", f.path);
      pathEl.title = f.path;
      const track = el("div", "heat-track");
      const bar = el("i", "heat-bar");
      bar.style.width = `${(f.total / max) * 100}%`;
      bar.style.background = f.write + f.edit > f.read ? "var(--yellow)" : "var(--accent)";
      track.appendChild(bar);
      const counts = `${f.read > 0 ? f.read + "r " : ""}${f.write > 0 ? f.write + "w " : ""}${f.edit > 0 ? f.edit + "e " : ""}${f.bash > 0 ? f.bash + "b" : ""}`;
      row.appendChild(pathEl);
      row.appendChild(track);
      row.appendChild(el("span", "heat-count", counts));
      heat.appendChild(row);
    }
    box.innerHTML = "";
    box.appendChild(heat);
  }

  // ---------- message log ----------
  function renderMessageLog(box, messages) {
    if (!messages?.length) { box.innerHTML = `<div class="empty">No messages.</div>`; return; }
    const log = el("div", "msg-log");
    for (const m of messages) {
      const cls = `msg msg-${m.role}${m.phase === "final_answer" ? " msg-final" : ""}`;
      const row = el("div", cls);
      const head = el("div", "msg-head");
      head.appendChild(el("span", "msg-role", `${m.role}${m.toolName ? ` · ${m.toolName}` : ""}`));
      head.appendChild(el("span", "msg-time", fmtTime(m.ts)));
      row.appendChild(head);
      row.appendChild(el("div", "msg-text", m.text));
      log.appendChild(row);
    }
    box.innerHTML = "";
    box.appendChild(log);
    log.scrollTop = log.scrollHeight;
  }

  // ---------- inspector ----------
  function renderInspector() {
    const existing = $(".inspector");
    if (existing) existing.remove();
    const node = state.inspected;
    if (!node) return;
    const overlay = el("div", "inspector");
    overlay.onclick = () => { state.inspected = null; renderInspector(); };
    const panel = el("div", "inspector-panel");
    panel.onclick = (e) => e.stopPropagation();
    if (node.inspect === "person") renderPersonInspector(panel, node);
    else if (node.inspect === "artifact") renderArtifactInspector(panel, node);
    else renderNodeInspector(panel, node);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
  }

  function inspectorChrome(panel, badge, kind, title) {
    const head = el("div", "inspector-head");
    if (badge) head.appendChild(el("span", `badge ${badge}`, badge));
    head.appendChild(el("span", "inspector-kind", kind));
    const close = el("button", "btn inspector-close", "✕");
    close.onclick = () => { state.inspected = null; renderInspector(); };
    head.appendChild(close);
    panel.appendChild(head);
    if (title) panel.appendChild(el("div", "inspector-label", title));
  }

  const ROLE_OPTIONS = [
    ["lead", "Lead"],
    ["worker", "Worker"],
    ["impl", "Impl"],
    ["review", "Reviewer"],
    ["advisor", "Advisor"],
    ["tester", "Tester"],
  ];

  function renderRolePicker(person) {
    const row = el("div", "inspector-row inspector-role-pick");
    row.appendChild(el("span", "", "role: "));
    const sel = el("select", "replay-select inspector-role");
    for (const [value, label] of ROLE_OPTIONS) {
      const o = el("option", "", label);
      o.value = value;
      if (effectiveRole(person) === value) o.selected = true;
      sel.appendChild(o);
    }
    sel.onchange = async () => {
      const sid = person.sessionId || state.selectedId;
      if (!sid) return;
      try {
        await api(`/api/v1/sessions/${encodeURIComponent(sid)}/role`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role: sel.value }),
        });
        await loadDetail(state.selectedId);
      } catch (err) {
        sel.blur();
        console.error(err);
      }
    };
    row.appendChild(sel);
    const srcLabel = { hod: "herdr", name: "start", user: "user", lead: "lead", unmapped: "unmapped" };
    const src = srcLabel[person.roleSource] || person.roleSource || "unmapped";
    row.appendChild(el("span", "muted", ` · ${src}`));
    return row;
  }

  function inspectorRow(label, value) {
    const row = el("div", "inspector-row");
    row.appendChild(el("span", "", `${label}: `));
    row.appendChild(el("code", "", value));
    return row;
  }

  function renderNodeInspector(panel, node) {
    inspectorChrome(panel, node.status, node.kind, node.label);
    if (node.toolName) panel.appendChild(inspectorRow("tool", node.toolName));
    if (node.turnId) panel.appendChild(inspectorRow("turn", node.turnId));
    if (node.agentId) panel.appendChild(inspectorRow("agent", node.agentId));
    if (node.durationMs != null) panel.appendChild(inspectorRow("duration", `${Math.round(node.durationMs / 1000)}s`));
    if (node.detail) panel.appendChild(el("pre", "inspector-detail", node.detail));
  }

  function renderPersonInspector(panel, person) {
    inspectorChrome(panel, person.status, person.kind === "lead" ? "lead" : "subagent", personLabel(person));
    panel.appendChild(inspectorRow("id", person.id));
    if (personRuntime(person)) panel.appendChild(inspectorRow("runtime", prettyRuntime(personRuntime(person)) || personRuntime(person)));
    const spawn = spawnName(person);
    if (spawn && spawn !== personLabel(person)) panel.appendChild(inspectorRow("spawn", spawn));
    panel.appendChild(renderRolePicker(person));
    if (person.currentWork) panel.appendChild(inspectorRow("work", displayWork(person.currentWork)));
    panel.appendChild(el("div", "inspector-note", "Attribution is best-effort from the session log."));

    if (person.toolBelt?.length) {
      panel.appendChild(el("div", "inspector-sub", "Tool belt"));
      const belt = el("div", "office-tools");
      for (const t of person.toolBelt) {
        belt.appendChild(el("span", "office-tool", `${t.name} ${t.count}`));
      }
      panel.appendChild(belt);
    }

    if (person.files?.length) {
      panel.appendChild(el("div", "inspector-sub", "Files"));
      for (const f of person.files.slice(0, 12)) {
        panel.appendChild(inspectorRow(f.path, `${f.read || 0}r ${f.write || 0}w ${f.edit || 0}e`));
      }
    }

    const hops = (state.detail?.office?.handoffs || [])
      .filter((h) => h.fromId === person.id || h.toId === person.id)
      .slice(-3);
    if (hops.length) {
      panel.appendChild(el("div", "inspector-sub", "Recent handoffs"));
      for (const h of hops) {
        panel.appendChild(el("div", "inspector-row", `${h.kind}: ${h.fromId} → ${h.toId}${h.summary ? " · " + h.summary : ""}`));
      }
    }
  }

  function renderArtifactInspector(panel, art) {
    inspectorChrome(panel, "idle", "artifact", art.path);
    panel.appendChild(inspectorRow("ops", `${art.read || 0}r ${art.write || 0}w ${art.edit || 0}e`));
    const names = (art.touchedBy || []).map((id) => personLabel(officePerson(state.detail?.office, id)) || id);
    panel.appendChild(inspectorRow("touched by", names.join(", ") || "unknown"));
    panel.appendChild(el("div", "inspector-note", "Who touched this file is attributed from the session log."));
  }

  // ---------- replay ----------
  function renderReplay() {
    const box = $("#view-replay");
    const active = state.tab === "replay";
    $("#view-replay").hidden = !active;
    if (!active) return;
    box.innerHTML = "";
    const panel = el("div", "replay panel");
    panel.appendChild(el("h3", "", "Replay / track JSONL"));
    const row = el("div", "replay-row");
    const sel = el("select", "replay-select");
    for (const [v, t] of [["claude", "Claude Code"], ["codex", "Codex"], ["grok", "Grok / Other"]]) {
      const o = el("option", "", t);
      o.value = v;
      sel.appendChild(o);
    }
    const input = el("input", "replay-input");
    input.placeholder = "JSONL file path (transcript / rollout)";
    const btn = el("button", "btn replay-btn", "▶ Replay");
    btn.onclick = async () => {
      if (!input.value.trim() || state.busy) return;
      state.busy = true;
      btn.textContent = "Reading…";
      try { await replay(sel.value, input.value.trim()); }
      catch (e) { panel.appendChild(el("div", "replay-error", String(e.message || e))); }
      finally { state.busy = false; btn.textContent = "▶ Replay"; }
    };
    row.appendChild(sel);
    row.appendChild(input);
    row.appendChild(btn);
    panel.appendChild(row);
    const hint = el("div", "replay-hint muted", "Examples:");
    hint.appendChild(el("code", "", "~/.claude/projects/-Users-…/session.jsonl (Claude)"));
    hint.appendChild(el("code", "", "~/.codex/sessions/2026/…/rollout-….jsonl (Codex)"));
    hint.appendChild(el("code", "", "~/.grok/sessions/…/<id>/updates.jsonl (Grok)"));
    panel.appendChild(hint);
    box.appendChild(panel);
  }

  // ---------- init ----------
  function init() {
    // pre-select ?_sess=
    const sess = new URLSearchParams(location.search).get("_sess");
    if (sess) state.selectedId = sess;

    // tabs
    document.querySelectorAll(".rt-tab[data-tab]").forEach((b) => {
      b.onclick = () => {
        state.tab = b.dataset.tab;
        document.querySelectorAll(".rt-tab[data-tab]").forEach((x) => x.classList.toggle("active", x === b));
        renderAll();
      };
    });

    loadSnapshot();
    if (state.selectedId) loadDetail(state.selectedId);
    setupSSE();
    setupPoll();
    window.addEventListener("resize", () => {
      const office = document.querySelector(".office");
      if (office) layoutOfficeRails(office);
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
