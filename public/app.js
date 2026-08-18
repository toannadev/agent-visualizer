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
    sidebarLimit: 20,
    detailFp: null,
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
      renderTopbar();
      renderDetail();
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
        const prev = idx >= 0 ? state.sessions[idx] : null;
        const summary = { meta: d.meta, metrics: d.metrics, officeCounts: d.officeCounts || null };
        if (idx >= 0) state.sessions[idx] = summary;
        else state.sessions.unshift(summary);
        const selected = state.selectedId === d.id;
        const teammate = !selected && isSelectedTeammate(d);
        if (selected || teammate) {
          if (prev && sessionListSig(prev) === sessionListSig(summary)) return;
          loadDetail(selected ? d.id : state.selectedId);
          renderSidebar();
          return;
        }
        if (!prev || sessionListSig(prev) !== sessionListSig(summary)) {
          renderTopbar();
          renderSidebar();
        }
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
      b.onclick = () => {
        state.runtimeFilter = f;
        state.sidebarLimit = 20;
        renderSidebar();
      };
      filterRow.appendChild(b);
    }
    box.appendChild(filterRow);

    const items = sidebarItems();
    if (!items.length) {
      box.appendChild(el("div", "empty", "No sessions."));
      return;
    }
    const limit = Math.min(state.sidebarLimit, items.length);
    for (let i = 0; i < limit; i++) {
      const it = items[i];
      box.appendChild(it.type === "team" ? renderTeamItem(it.g) : renderSessionItem(it.s));
    }
    if (limit < items.length) {
      const more = el("div", "sidebar-more", `Scroll for more · ${items.length - limit} left`);
      more.id = "sidebar-sentinel";
      box.appendChild(more);
      observeSidebarMore();
    }
  }

  function sidebarItems() {
    const { groups, loose } = groupSessions(state.sessions);
    return [
      ...groups.filter((g) => g.members.some(matchesRuntime)).map((g) => ({ type: "team", g })),
      ...loose.filter(matchesRuntime).map((s) => ({ type: "session", s })),
    ];
  }

  function observeSidebarMore() {
    const sent = $("#sidebar-sentinel");
    const root = $("#sidebar");
    if (!sent || !root) return;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      state.sidebarLimit += 20;
      renderSidebar();
    }, { root, rootMargin: "80px" });
    io.observe(sent);
  }

  function sessionListSig(s) {
    const m = s?.meta || {};
    const t = m.team || {};
    const c = s?.officeCounts || {};
    return [
      m.id, m.status, m.runtime, m.title, m.cwd,
      t.id, t.herdrName, t.exited, t.herdrStatus,
      s?.metrics?.toolCount, s?.metrics?.errorCount,
      c.people, c.doing, c.blocked,
    ].join("\0");
  }

  function isSelectedTeammate(d) {
    const selected = state.sessions.find((s) => s?.meta?.id === state.selectedId);
    const tid = selected?.meta?.team?.id;
    return Boolean(tid && d?.meta?.team?.id === tid);
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
    item.appendChild(top);
    item.appendChild(el("div", "s-title", g.label || "team"));
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
    item.appendChild(top);
    item.appendChild(el("div", "s-title", m.title || m.cwd || m.projectDir || m.id));
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
      state.detailFp = null;
      if (graphSim) { graphSim.stop(); graphSim = null; }
      graphMount = null;
      if (state.tab === "sessions" && !state.detail && !state.error) {
        wrap.innerHTML = `<div class="empty">Select a session from the sidebar…</div>`;
      }
      return;
    }
    const s = state.detail;
    refreshInspected(s.office);
    const fp = detailFingerprints(s);
    const reuse = wrap.dataset.sid === s.meta.id && wrap.querySelector(".v-main-grid") && state.detailFp;
    if (reuse) {
      if (state.detailFp.head !== fp.head) replaceDetailHead(wrap, s);
      const officeBox = wrap.querySelector(".office-panel-body");
      const graphBox = wrap.querySelector(".graph-panel-body");
      const heatBox = wrap.querySelector(".v-main-grid .v-panel-wrap:nth-child(3) > div:last-child");
      const msgBox = wrap.querySelector(".v-main-grid .v-panel-wrap:nth-child(4) > div:last-child");
      if (state.detailFp.office !== fp.office && officeBox) {
        setPanelTitle(wrap, ".office-panel", officePanelTitle(s.office));
        renderOffice(officeBox, s.office);
      }
      if (graphBox && state.detailFp.graph !== fp.graph) {
        setPanelTitle(wrap, ".graph-panel", graphPanelTitle(s.office));
        paintGraph(graphBox, s.graph, { compact: true });
      } else {
        applyGraphFocus();
      }
      if (heatBox && state.detailFp.heat !== fp.heat) {
        const focus = forensicFocus(s.office);
        setPanelTitle(wrap, ".v-panel-wrap:nth-child(3)", focus ? `Files · ${personLabel(focus)}` : "Files");
        renderHeatmap(heatBox, focusedFiles(s.office, s.heatmap), { filtered: Boolean(focus) });
      }
      if (msgBox && state.detailFp.msg !== fp.msg) {
        setPanelTitle(wrap, ".v-panel-wrap:nth-child(4)", `Messages (${s.messages.length})`);
        renderMessageLog(msgBox, s.messages);
      }
      state.detailFp = fp;
      return;
    }

    buildDetailShell(wrap, s);
    state.detailFp = fp;
  }

  function detailFingerprints(s) {
    return {
      head: [
        s.meta.id, s.meta.status, s.meta.title, s.meta.path,
        s.metrics?.toolCount, s.metrics?.tokenTotal, s.metrics?.durationMs,
        s.metrics?.fileCount, s.metrics?.errorCount,
      ].join("\0"),
      office: officeFingerprint(s.office),
      graph: graphTopologyKey(s.graph) + "\n" + graphPaintKey(s.graph),
      heat: focusedFiles(s.office, s.heatmap).map((f) => `${f.path}:${f.total}`).join("\n"),
      msg: `${s.messages.length}\0${s.messages.at(-1)?.id || ""}`,
    };
  }

  function officeFingerprint(office) {
    const people = (office?.people || []).map((p) => [
      p.id, p.status, p.herdrName, p.exited, p.currentWork, p.errorCount,
      (p.tasks || []).map((t) => t.title).join(","),
      (p.assignments || []).map((a) => a.task).join(","),
    ].join("|"));
    return `${state.focusedPerson || ""}\0${office?.counts?.people || 0}\0${people.join(";")}`;
  }

  function graphPanelTitle(office) {
    const focus = forensicFocus(office);
    return focus
      ? `Forensics · Execution Graph · ${personLabel(focus)}`
      : "Forensics · Execution Graph";
  }

  function setPanelTitle(wrap, sel, title) {
    const node = wrap.querySelector(`${sel} .v-panel-title`);
    if (node) node.textContent = title;
  }

  function replaceDetailHead(wrap, s) {
    const prev = wrap.querySelector(".detail-head");
    const next = buildDetailHead(s);
    if (prev) prev.replaceWith(next);
    else wrap.prepend(next);
  }

  function buildDetailHead(s) {
    const m = s.meta, met = s.metrics;
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
    return head;
  }

  function buildDetailShell(wrap, s) {
    wrap.dataset.sid = s.meta.id;
    wrap.innerHTML = "";
    wrap.appendChild(buildDetailHead(s));

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
    const graphBox = mkPanel(graphPanelTitle(s.office), "graph-panel");
    const focus = forensicFocus(s.office);
    const heatBox = mkPanel(focus ? `Files · ${personLabel(focus)}` : "Files");
    const msgBox = mkPanel(`Messages (${s.messages.length})`);
    wrap.appendChild(grid);

    renderOffice(officeBox, s.office);
    renderHeatmap(heatBox, focusedFiles(s.office, s.heatmap), { filtered: Boolean(focus) });
    renderMessageLog(msgBox, s.messages);
    paintGraph(graphBox, s.graph, { compact: true });
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
    if (id === "user") return userPersonFromOffice(office);
    return (office?.people || []).find((p) => p.id === id) || null;
  }

  function forensicFocus(office) {
    if (!state.focusedPerson || state.focusedPerson === "user") return null;
    return officePerson(office, state.focusedPerson);
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
    const person = forensicFocus(office);
    if (!person) return heatmap || [];
    const allowed = new Set((person.files || []).map((f) => f.path));
    if (!allowed.size) return heatmap || [];
    return (heatmap || []).filter((f) => allowed.has(f.path));
  }

  function refreshInspected(office) {
    const node = state.inspected;
    if (!node || !office) return;
    if (node.inspect === "person") {
      const fresh = node.id === "user" ? userPersonFromOffice(office) : officePerson(office, node.id);
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
    renderDetail();
    renderInspector();
  }

  function focusPerson(person) {
    state.focusedPerson = person.id;
    state.inspected = { inspect: "person", ...person };
    renderDetail();
    renderInspector();
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
    userNode.appendChild(renderUserCard(office));

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

  function userPersonFromOffice(office) {
    const briefs = office?.briefs?.length
      ? office.briefs
      : (office?.brief ? [{ title: office.brief, full: office.brief }] : []);
    return {
      id: "user",
      kind: "user",
      label: "User",
      status: "idle",
      roleHint: "",
      tasks: briefs,
    };
  }

  function renderUserCard(office) {
    const person = userPersonFromOffice(office);
    const selected = state.focusedPerson === "user" ? " is-selected" : "";
    const card = el("button", `office-desk office-desk-user${selected}`);
    card.type = "button";
    card.addEventListener("click", (evt) => {
      evt.stopPropagation();
      if (state.focusedPerson === "user" && state.inspected?.inspect === "person") {
        clearOfficeFocus();
      } else {
        focusPerson(person);
      }
    });
    const top = el("div", "office-desk-top");
    top.appendChild(el("span", "office-desk-name", "User"));
    card.appendChild(top);
    if (person.tasks.length) {
      card.appendChild(renderAssignGroups(person.tasks.map((t) => ({
        who: "", task: t.title, full: t.full || t.title, status: t.status,
      })), { full: false }));
    } else {
      card.appendChild(el("div", "office-desk-work", "asked"));
    }
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
    const role = effectiveRole(person);
    const roleBadge = roleBadgeText(person);
    if (roleBadge) top.appendChild(el("span", `office-role role-${role}`, roleBadge));
    card.appendChild(top);
    const spawn = spawnName(person);
    if (spawn) card.appendChild(el("div", "office-desk-name", spawn));

    const assigns = person.kind === "lead"
      ? (person.assignments || [])
      : (person.tasks || []).map((t) => ({
        who: "", task: t.title, full: t.full || t.title,
        result: t.result, resultFull: t.resultFull, status: t.status,
      }));
    if (assigns.length) {
      card.appendChild(renderAssignGroups(assigns, { full: false }));
    } else {
      card.appendChild(el("div", "office-desk-work", displayWork(person.currentWork) || "Idle"));
    }

    if (person.exited) {
      card.appendChild(el("div", "office-desk-meta", "offline"));
      card.classList.add("is-offline");
    }
    if (person.errorCount) {
      card.appendChild(el("div", "office-desk-meta office-err", `${person.errorCount} err`));
    }
    card.classList.add(`office-desk-role-${role}`);
    return card;
  }

  function groupAssigns(assigns) {
    const groups = [];
    const byWho = new Map();
    for (const a of assigns || []) {
      const key = String(a.who || "");
      if (!byWho.has(key)) {
        const g = { who: a.who || "", items: [] };
        byWho.set(key, g);
        groups.push(g);
      }
      byWho.get(key).items.push(a);
    }
    return groups;
  }

  function renderAssignGroups(assigns, { full = false } = {}) {
    const box = el("div", "office-assigns");
    if (!full) box.addEventListener("wheel", (evt) => evt.stopPropagation(), { passive: true });
    for (const g of groupAssigns(assigns)) {
      const group = el("div", "office-assign-group");
      if (g.who) group.appendChild(el("span", "office-assign-who", g.who));
      const list = el("ul", "office-assign-list");
      for (const a of g.items) {
        const item = el("li", `office-assign-task ${a.status || ""}`);
        const ask = el("div", "office-assign-ask");
        ask.textContent = full
          ? String(a.full || a.task || "").trim()
          : displayWork(a.task) || "";
        if (full && a.status) {
          ask.appendChild(el("span", `badge ${a.status} inspector-assign-status`, a.status));
        }
        item.appendChild(ask);
        const result = full ? String(a.resultFull || a.result || "").trim() : displayWork(a.result || "");
        if (result) item.appendChild(el("div", "office-assign-result", result));
        list.appendChild(item);
      }
      group.appendChild(list);
      box.appendChild(group);
    }
    return box;
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
  const GRAPH_VISIBLE_KINDS = new Set([
    "session_root", "user_prompt", "agent_message", "tool_call", "error", "subagent_start",
  ]);
  let graphSim = null;
  let graphMount = null;

  function graphNodeId(value) {
    return typeof value === "object" ? value?.id : value;
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

  // Keep the execution graph readable while retaining the full data elsewhere.
  function simplifyGraph(graph) {
    const sourceNodes = graph?.nodes || [];
    const nodes = sourceNodes
      .filter((node) => GRAPH_VISIBLE_KINDS.has(node.kind))
      // The synthetic root already represents the session start.
      .filter((node) => node.kind !== "session_root" || node.id === "root")
      .filter((node) => !isGraphNoise(node))
      .map((node) => ({ ...node }));
    const visibleIds = new Set(nodes.map((node) => node.id));
    const outgoing = new Map();

    for (const link of graph?.links || []) {
      const source = graphNodeId(link.source);
      const target = graphNodeId(link.target);
      if (!source || !target) continue;
      if (!outgoing.has(source)) outgoing.set(source, []);
      outgoing.get(source).push({ target, kind: link.kind });
    }

    const links = [];
    const linkKeys = new Set();
    const addLink = (source, target, kind) => {
      if (!visibleIds.has(source) || !visibleIds.has(target) || source === target) return;
      const key = `${source}\u0000${target}`;
      if (linkKeys.has(key)) return;
      linkKeys.add(key);
      links.push({ source, target, kind });
    };

    for (const node of nodes) {
      const pending = [...(outgoing.get(node.id) || [])];
      const visited = new Set();
      while (pending.length) {
        const next = pending.pop();
        if (!next || visited.has(next.target)) continue;
        visited.add(next.target);
        if (visibleIds.has(next.target)) {
          addLink(node.id, next.target, next.kind);
        } else {
          pending.push(...(outgoing.get(next.target) || []));
        }
      }
    }

    return { nodes, links };
  }

  function addGraphLegend(box) {
    const legend = el("div", "graph-legend");
    const items = [
      ["session_root", "Start"], ["user_prompt", "Prompt"], ["agent_message", "Agent"],
      ["tool_call", "Tool"], ["subagent_start", "Subagent"], ["error", "Error"],
    ];
    for (const [kind, label] of items) {
      const item = el("span", "graph-legend-item");
      const dot = el("span", "graph-legend-dot");
      dot.style.background = KIND_COLOR[kind];
      item.appendChild(dot);
      item.appendChild(document.createTextNode(label));
      legend.appendChild(item);
    }
    legend.appendChild(el("span", "graph-legend-note", "(reasoning, tool results, and end nodes hidden)"));
    box.appendChild(legend);
  }

  function graphTopologyKey(graph) {
    const g = simplifyGraph(graph);
    return [
      g.nodes.map((n) => n.id).sort().join("\n"),
      g.links.map((l) => `${graphNodeId(l.source)}\t${graphNodeId(l.target)}`).sort().join("\n"),
    ].join("\n#\n");
  }

  function graphPaintKey(graph) {
    const g = simplifyGraph(graph);
    return g.nodes
      .map((n) => `${n.id}\t${n.kind}\t${n.status || ""}\t${(n.label || "").slice(0, 30)}`)
      .sort()
      .join("\n");
  }

  function applyGraphFocus() {
    if (!graphMount?.nodeEls) return;
    const focusIds = focusedEventIds();
    for (const { g, n } of graphMount.nodeEls) {
      g.classList.toggle("is-dim", Boolean(focusIds && !nodeBelongsToFocus(n, focusIds)));
    }
  }

  function paintGraphNodes() {
    if (!graphMount?.nodeEls) return;
    const focusIds = focusedEventIds();
    for (const { g, n, circle, text } of graphMount.nodeEls) {
      circle.setAttribute("fill", KIND_COLOR[n.kind] || "#8b949e");
      circle.style.animation = n.status === "running" ? "pulse 1.4s infinite" : "";
      text.textContent = (n.label || n.id).slice(0, 30);
      g.classList.toggle("is-dim", Boolean(focusIds && !nodeBelongsToFocus(n, focusIds)));
    }
  }

  function paintGraph(box, graph, opts = {}) {
    try {
      renderGraph(box, graph, opts);
    } catch (err) {
      console.error("Graph render failed", err);
      graphMount = null;
      renderStaticGraph(box, graph);
    }
  }

  function renderGraph(box, graph, opts = {}) {
    const displayGraph = simplifyGraph(graph);
    const topologyKey = graphTopologyKey(graph);
    const paintKey = graphPaintKey(graph);
    if (
      graphMount
      && graphMount.box === box
      && graphMount.topologyKey === topologyKey
      && box.contains(graphMount.wrap)
    ) {
      if (graphMount.paintKey !== paintKey) {
        const byId = new Map(displayGraph.nodes.map((n) => [n.id, n]));
        for (const rec of graphMount.nodeEls) {
          const fresh = byId.get(rec.n.id);
          if (fresh) Object.assign(rec.n, { kind: fresh.kind, status: fresh.status, label: fresh.label });
        }
        graphMount.paintKey = paintKey;
        paintGraphNodes();
      } else {
        applyGraphFocus();
      }
      return;
    }

    const prevPos = new Map();
    if (graphMount?.nodes) {
      for (const n of graphMount.nodes) {
        if (n.id != null && n.x != null) prevPos.set(n.id, { x: n.x, y: n.y });
      }
    }
    if (graphSim) graphSim.stop();
    graphSim = null;
    graphMount = null;

    box.innerHTML = "";
    addGraphLegend(box);
    const wrap = el("div", `graph-wrap${opts.compact ? " graph-wrap-forensics" : ""}`);
    box.appendChild(wrap);
    if (!displayGraph.nodes.length) { wrap.appendChild(el("div", "empty", "No data.")); return; }

    const width = Math.max(360, wrap.clientWidth || 640);
    const height = Math.max(opts.compact ? 520 : 640, wrap.clientHeight || 720);
    const focusIds = focusedEventIds();
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    wrap.appendChild(svg);

    const nodes = displayGraph.nodes;
    const links = displayGraph.links;
    for (const n of nodes) {
      const pos = prevPos.get(n.id);
      if (pos) { n.x = pos.x; n.y = pos.y; }
    }
    const reused = prevPos.size > 0 && nodes.some((n) => prevPos.has(n.id));
    const sim = d3.forceSimulation(nodes)
      .force("link", d3.forceLink(links).id((d) => d.id).distance(50).strength(0.5))
      .force("charge", d3.forceManyBody().strength(-240))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("collide", d3.forceCollide(24))
      .alpha(reused ? 0.18 : 1)
      .alphaDecay(0.08);

    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    svg.appendChild(g);
    let zoom = 1, panX = 0, panY = 0, panState = null;
    const applyTransform = () => g.setAttribute("transform", `translate(${panX} ${panY}) scale(${zoom})`);
    const toGraphPoint = (evt) => {
      const rect = svg.getBoundingClientRect();
      return { x: (evt.clientX - rect.left - panX) / zoom, y: (evt.clientY - rect.top - panY) / zoom };
    };
    svg.addEventListener("wheel", (evt) => {
      evt.preventDefault();
      zoom = Math.min(3, Math.max(0.3, zoom * (evt.deltaY < 0 ? 1.08 : 0.92)));
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

    const nodeEls = [];
    nodes.forEach((n) => {
      const gn = document.createElementNS("http://www.w3.org/2000/svg", "g");
      gn.classList.add("g-node");
      if (focusIds && !nodeBelongsToFocus(n, focusIds)) gn.classList.add("is-dim");
      const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      c.setAttribute("r", n.kind === "session_root" ? "10" : n.kind === "user_prompt" ? "8" : "7");
      c.setAttribute("fill", KIND_COLOR[n.kind] || "#8b949e");
      if (n.status === "running") c.style.animation = "pulse 1.4s infinite";
      if (n.kind === "error") c.style.stroke = "var(--red)";
      const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
      t.setAttribute("x", "12");
      t.setAttribute("y", "4");
      t.textContent = (n.label || n.id).slice(0, 30);
      gn.appendChild(c);
      gn.appendChild(t);
      let dragging = null;
      gn.addEventListener("pointerdown", (evt) => {
        evt.stopPropagation();
        gn.setPointerCapture?.(evt.pointerId);
        dragging = { moved: false };
        n.fx = n.x;
        n.fy = n.y;
        sim.alphaTarget(0.25).restart();
      });
      gn.addEventListener("pointermove", (evt) => {
        if (!dragging) return;
        const p = toGraphPoint(evt);
        n.fx = p.x;
        n.fy = p.y;
        dragging.moved = true;
      });
      gn.addEventListener("pointerup", (evt) => {
        if (!dragging) return;
        const wasMoved = dragging.moved;
        dragging = null;
        n.fx = null;
        n.fy = null;
        sim.alphaTarget(0);
        gn.releasePointerCapture?.(evt.pointerId);
        if (!wasMoved) { state.inspected = n; renderInspector(); }
      });
      g.appendChild(gn);
      nodeEls.push({ g: gn, n, circle: c, text: t });
    });

    const lineEls = [];
    links.forEach(() => {
      const l = document.createElementNS("http://www.w3.org/2000/svg", "line");
      l.classList.add("g-link");
      g.insertBefore(l, g.firstChild);
      lineEls.push(l);
    });
    sim.on("tick", () => {
      lineEls.forEach((l, i) => {
        const d = links[i];
        const source = typeof d.source === "object" ? d.source : nodes.find((n) => n.id === d.source);
        const target = typeof d.target === "object" ? d.target : nodes.find((n) => n.id === d.target);
        if (!source || !target) return;
        l.setAttribute("x1", String(source.x ?? 0));
        l.setAttribute("y1", String(source.y ?? 0));
        l.setAttribute("x2", String(target.x ?? 0));
        l.setAttribute("y2", String(target.y ?? 0));
      });
      nodeEls.forEach(({ g: gn, n }) => {
        gn.setAttribute("transform", `translate(${n.x ?? 0},${n.y ?? 0})`);
      });
    });
    sim.on("end", () => {
      if (graphSim === sim) sim.stop();
    });
    graphSim = sim;
    graphMount = {
      box, wrap, topologyKey, paintKey, nodes, links, nodeEls, lineEls, sim,
    };
  }

  function focusedEventIds() {
    const person = forensicFocus(state.detail?.office);
    if (!person?.eventIds?.length) return null;
    return new Set(person.eventIds);
  }

  function nodeBelongsToFocus(node, focusIds) {
    const person = forensicFocus(state.detail?.office);
    if (person?.sessionId && node.sessionId) {
      return node.sessionId === person.sessionId;
    }
    if (!focusIds) return true;
    if (focusIds.has(node.id) || focusIds.has(node.eventId)) return true;
    if (state.focusedPerson === "lead" && node.kind === "user_prompt") return true;
    if (node.agentId && node.agentId === state.focusedPerson) return true;
    return false;
  }
  function renderStaticGraph(box, graph) {
    box.innerHTML = "";
    const displayGraph = simplifyGraph(graph);
    addGraphLegend(box);
    const wrap = el("div", "graph-wrap");
    box.appendChild(wrap);
    const nodes = displayGraph.nodes;
    if (!nodes.length) { wrap.appendChild(el("div", "empty", "No data.")); return; }
    const width = Math.max(360, wrap.clientWidth || 640);
    const height = Math.max(640, wrap.clientHeight || 720);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    wrap.appendChild(svg);
    const byDepth = new Map();
    for (const n of nodes) {
      const depth = Number(n.depth) || 0;
      if (!byDepth.has(depth)) byDepth.set(depth, []);
      byDepth.get(depth).push(n);
    }
    const maxDepth = Math.max(0, ...nodes.map((n) => Number(n.depth) || 0));
    const gapY = Math.max(42, Math.min(90, (height - 40) / Math.max(1, maxDepth + 1)));
    for (const [depth, group] of byDepth) {
      const gapX = width / (group.length + 1);
      group.forEach((n, i) => { n.x = gapX * (i + 1); n.y = 25 + depth * gapY; });
    }
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    svg.appendChild(g);
    let scale = 1, panX = 0, panY = 0, panning = null, dragging = null;
    const applyTransform = () => g.setAttribute("transform", `translate(${panX} ${panY}) scale(${scale})`);
    const point = (e) => {
      const r = svg.getBoundingClientRect();
      return { x: (e.clientX - r.left - panX) / scale, y: (e.clientY - r.top - panY) / scale };
    };
    const lineEls = [];
    for (const link of displayGraph.links) {
      const source = byId.get(typeof link.source === "object" ? link.source.id : link.source);
      const target = byId.get(typeof link.target === "object" ? link.target.id : link.target);
      if (!source || !target) continue;
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.classList.add("g-link");
      g.appendChild(line);
      lineEls.push({ line, source, target });
    }
    const nodeEls = [];
    const update = () => {
      for (const { line, source, target } of lineEls) {
        line.setAttribute("x1", String(source.x)); line.setAttribute("y1", String(source.y));
        line.setAttribute("x2", String(target.x)); line.setAttribute("y2", String(target.y));
      }
      for (const { group, node } of nodeEls) group.setAttribute("transform", `translate(${node.x} ${node.y})`);
    };
    for (const node of nodes) {
      const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
      group.classList.add("g-node");
      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circle.setAttribute("r", node.kind === "session_root" ? "10" : "7");
      circle.setAttribute("fill", KIND_COLOR[node.kind] || "#8b949e");
      const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
      text.setAttribute("x", "12"); text.setAttribute("y", "4"); text.textContent = (node.label || node.id).slice(0, 28);
      group.appendChild(circle); group.appendChild(text); g.appendChild(group);
      let moved = false;
      group.addEventListener("pointerdown", (e) => {
        e.stopPropagation(); group.setPointerCapture?.(e.pointerId); dragging = { node, moved: false };
      });
      group.addEventListener("pointermove", (e) => {
        if (!dragging || dragging.node !== node) return;
        const p = point(e); node.x = p.x; node.y = p.y; dragging.moved = true; update();
      });
      group.addEventListener("pointerup", (e) => {
        if (dragging?.node === node) {
          if (!dragging.moved) { state.inspected = node; renderInspector(); }
          dragging = null; group.releasePointerCapture?.(e.pointerId);
        }
      });
      nodeEls.push({ group, node });
    }
    svg.addEventListener("pointerdown", (e) => {
      if (e.target !== svg) return;
      panning = { x: e.clientX, y: e.clientY, panX, panY };
      svg.setPointerCapture?.(e.pointerId);
    });
    svg.addEventListener("pointermove", (e) => {
      if (!panning) return;
      panX = panning.panX + e.clientX - panning.x; panY = panning.panY + e.clientY - panning.y; applyTransform();
    });
    svg.addEventListener("pointerup", (e) => { panning = null; svg.releasePointerCapture?.(e.pointerId); });
    svg.addEventListener("wheel", (e) => {
      e.preventDefault(); scale = Math.min(3, Math.max(0.3, scale * (e.deltaY < 0 ? 1.1 : 0.9))); applyTransform();
    }, { passive: false });
    update();
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

  function inspectorChrome(panel, badge, kind, title, { role } = {}) {
    const head = el("div", "inspector-head");
    if (badge) head.appendChild(el("span", `badge ${badge}`, badge));
    if (kind) {
      head.appendChild(el("span", role ? `office-role role-${role}` : "inspector-kind", kind));
    }
    const close = el("button", "btn inspector-close", "✕");
    close.onclick = () => { state.inspected = null; renderInspector(); };
    head.appendChild(close);
    panel.appendChild(head);
    if (title) panel.appendChild(el("div", "inspector-label", title));
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
    if (person.kind === "user") {
      inspectorChrome(panel, "", "user", "User");
    } else {
      inspectorChrome(panel, person.status, roleBadgeText(person) || person.kind, personLabel(person), {
        role: effectiveRole(person),
      });
    }
    const body = el("div", "inspector-body");
    const assigns = person.kind === "lead"
      ? (person.assignments || [])
      : (person.tasks || []).map((t) => ({
        who: "", task: t.title, full: t.full || t.title,
        result: t.result, resultFull: t.resultFull, status: t.status,
      }));
    if (assigns.length) {
      body.appendChild(renderAssignGroups(assigns, { full: true }));
    } else if (person.currentWork) {
      body.appendChild(el("div", "inspector-work", String(person.currentWork).trim()));
    }
    if (person.errorCount) {
      body.appendChild(el("div", "office-desk-meta office-err", `${person.errorCount} err`));
    }
    panel.appendChild(body);
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
