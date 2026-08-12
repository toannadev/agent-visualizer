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

  function esc(s) {
    if (s == null) return "";
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

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

  function fmtTime(ts) {
    if (!ts) return "–";
    const d = new Date(ts);
    if (isNaN(d)) return "–";
    return d.toLocaleString("vi-VN", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
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
        const summary = { meta: d.meta, metrics: d.metrics };
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
  function renderSidebar() {
    const box = $("#sidebar");
    box.innerHTML = "";
    const filterRow = el("div", "rt-filter");
    for (const f of ["all", "claude", "codex"]) {
      const b = el("button", `rt-tab ${state.runtimeFilter === f ? "active" : ""}`, f === "all" ? "All" : f);
      b.onclick = () => { state.runtimeFilter = f; renderSidebar(); };
      filterRow.appendChild(b);
    }
    box.appendChild(filterRow);

    const filtered = state.sessions.filter((s) => state.runtimeFilter === "all" || s?.meta?.runtime === state.runtimeFilter);
    if (!filtered.length) box.appendChild(el("div", "empty", "No sessions."));
    for (const s of filtered) {
      const m = s?.meta;
      if (!m) continue;
      const item = el("div", `session-item ${m.id === state.selectedId ? "active" : ""}`);
      item.onclick = () => { state.selectedId = m.id; loadDetail(m.id); };
      const top = el("div", "s-top");
      top.appendChild(el("span", `rt-badge ${m.runtime}`, m.runtime));
      const badge = el("span", `badge ${m.status}`);
      const dot = el("span", "dot");
      dot.style.background = m.status === "running" ? "var(--green)" : "var(--muted)";
      badge.appendChild(dot);
      badge.appendChild(document.createTextNode(m.status));
      top.appendChild(badge);
      top.appendChild(el("div", "s-title", m.cwd || m.projectDir || m.id));
      item.appendChild(top);
      const meta = el("div", "s-meta");
      meta.appendChild(el("span", "", `${s.metrics?.toolCount ?? 0} tool`));
      meta.appendChild(el("span", "", fmtTime(m.mtimeMs)));
      if (m.model) meta.appendChild(el("span", "", m.model));
      item.appendChild(meta);
      box.appendChild(item);
    }
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

    const head = el("div", "detail-head");
    const hLeft = el("div");
    const h2 = el("h2");
    h2.appendChild(el("span", `rt-badge ${m.runtime}`, m.runtime));
    h2.appendChild(document.createTextNode(` ${m.cwd || m.projectDir || m.id} `));
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
      const body = el("div");
      p.appendChild(body);
      grid.appendChild(p);
      return body;
    };

    const graphBox = mkPanel("Execution Graph", "graph-panel");
    const heatBox = mkPanel("Files");
    const msgBox = mkPanel(`Messages (${s.messages.length})`);
    wrap.appendChild(grid);

    try {
      renderGraph(graphBox, s.graph);
    } catch (err) {
      console.error("Graph render failed", err);
      renderStaticGraph(graphBox, s.graph);
    }
    renderHeatmap(heatBox, s.heatmap);
    renderMessageLog(msgBox, s.messages);
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

  function graphNodeId(value) {
    return typeof value === "object" ? value?.id : value;
  }

  // Keep the execution graph readable while retaining the full data elsewhere.
  function simplifyGraph(graph) {
    const sourceNodes = graph?.nodes || [];
    const nodes = sourceNodes
      .filter((node) => GRAPH_VISIBLE_KINDS.has(node.kind))
      // The synthetic root already represents the session start.
      .filter((node) => node.kind !== "session_root" || node.id === "root")
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

  function renderGraph(box, graph) {
    box.innerHTML = "";
    const displayGraph = simplifyGraph(graph);
    addGraphLegend(box);
    const wrap = el("div", "graph-wrap");
    box.appendChild(wrap);
    if (!displayGraph.nodes.length) { wrap.appendChild(el("div", "empty", "No data.")); return; }

    const width = Math.max(360, wrap.clientWidth || 640);
    const height = 540;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    wrap.appendChild(svg);

    const nodes = displayGraph.nodes;
    const links = displayGraph.links;
    const sim = d3.forceSimulation(nodes)
      .force("link", d3.forceLink(links).id((d) => d.id).distance(50).strength(0.5))
      .force("charge", d3.forceManyBody().strength(-240))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("collide", d3.forceCollide(24));

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
      nodeEls.push({ g: gn, n });
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
    if (graphSim) graphSim.stop();
    graphSim = sim;
  }
  function renderStaticGraph(box, graph) {
    box.innerHTML = "";
    const displayGraph = simplifyGraph(graph);
    addGraphLegend(box);
    const wrap = el("div", "graph-wrap");
    box.appendChild(wrap);
    const nodes = displayGraph.nodes;
    if (!nodes.length) { wrap.appendChild(el("div", "empty", "No data.")); return; }
    const width = Math.max(360, wrap.clientWidth || 640), height = 540;
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
  function renderHeatmap(box, files) {
    if (!files?.length) { box.innerHTML = `<div class="empty">No files accessed.</div>`; return; }
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
    const head = el("div", "inspector-head");
    head.appendChild(el("span", `badge ${node.status}`, node.status));
    head.appendChild(el("span", "inspector-kind", node.kind));
    const close = el("button", "btn inspector-close", "✕");
    close.onclick = () => { state.inspected = null; renderInspector(); };
    head.appendChild(close);
    panel.appendChild(head);
    panel.appendChild(el("div", "inspector-label", node.label));
    if (node.toolName) panel.appendChild(el("div", "inspector-row", `tool: <code>${esc(node.toolName)}</code>`));
    if (node.turnId) panel.appendChild(el("div", "inspector-row", `turn: <code>${esc(node.turnId)}</code>`));
    if (node.agentId) panel.appendChild(el("div", "inspector-row", `agent: <code>${esc(node.agentId)}</code>`));
    if (node.durationMs != null) panel.appendChild(el("div", "inspector-row", `duration: <b>${Math.round(node.durationMs / 1000)}s</b>`));
    if (node.detail) panel.appendChild(el("pre", "inspector-detail", node.detail));
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
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
    for (const [v, t] of [["claude", "Claude Code"], ["codex", "Codex"]]) {
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
  }

  document.addEventListener("DOMContentLoaded", init);
})();
