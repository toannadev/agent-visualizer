import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ASSIGNABLE_ROLES,
  canonicalizeRole,
  parseHodRelation,
  parseHodRole,
  parseRoleDirective,
  resolveRole,
  roleFromAgentName,
  roleFromSettingsPath,
} from "./roles.mjs";
import { attachHerdrTeams } from "./herdr.mjs";
import { buildOffice, mergeTeamView } from "./office.mjs";

describe("parseHodRole", () => {
  it("accepts only HOD topology tokens", () => {
    assert.equal(parseHodRole("controller"), "controller");
    assert.equal(parseHodRole(" worker "), "worker");
    assert.equal(parseHodRole("advisor"), "advisor");
    assert.equal(parseHodRole("reviewer"), "reviewer");
    assert.equal(parseHodRole("tester"), "tester");
  });

  it("rejects profile names and start-name aliases as tokens", () => {
    assert.equal(parseHodRole("impl"), null);
    assert.equal(parseHodRole("implementer"), null);
    assert.equal(parseHodRole("lead"), null);
    assert.equal(parseHodRole("advisor-1"), null);
    assert.equal(parseHodRole(""), null);
    assert.equal(parseHodRole(null), null);
  });
});

describe("parseHodRelation", () => {
  it("accepts only HOD relations", () => {
    assert.equal(parseHodRelation("delegate"), "delegate");
    assert.equal(parseHodRelation("consult"), "consult");
    assert.equal(parseHodRelation("verify"), "verify");
    assert.equal(parseHodRelation("parent"), null);
  });
});

describe("roleFromAgentName", () => {
  it("reads the name the user passed to herdr agent start", () => {
    assert.equal(roleFromAgentName("impl"), "impl");
    assert.equal(roleFromAgentName("impl-1"), "impl");
    assert.equal(roleFromAgentName("api_impl"), "impl");
    assert.equal(roleFromAgentName("reviewer"), "review");
    assert.equal(roleFromAgentName("reviewer-1"), "review");
    assert.equal(roleFromAgentName("controller"), "lead");
    assert.equal(roleFromAgentName("tester"), "tester");
    assert.equal(roleFromAgentName("advisor-1"), "advisor");
    assert.equal(roleFromAgentName("worker-2"), "worker");
  });

  it("does not guess from ordinary words in a name", () => {
    assert.equal(roleFromAgentName("review-bot"), null);
    assert.equal(roleFromAgentName("coord"), null);
    assert.equal(roleFromAgentName("planner"), null);
    assert.equal(roleFromAgentName("claude"), null);
    assert.equal(roleFromAgentName(""), null);
  });
});

describe("roleFromSettingsPath", () => {
  it("reads the profile file the user passed after --", () => {
    assert.equal(roleFromSettingsPath(".claude/settings.impl.json"), "impl");
    assert.equal(roleFromSettingsPath("/repo/.claude/settings.reviewer.json"), "review");
    assert.equal(roleFromSettingsPath(".claude/settings.controller.json"), "lead");
    assert.equal(roleFromSettingsPath("package.json"), null);
  });
});

describe("canonicalizeRole", () => {
  it("maps HOD tokens and Desktop start names onto office ids", () => {
    assert.equal(canonicalizeRole("controller"), "lead");
    assert.equal(canonicalizeRole("reviewer"), "review");
    assert.equal(canonicalizeRole("worker"), "worker");
    assert.equal(canonicalizeRole("impl"), "impl");
    assert.equal(canonicalizeRole("unmapped"), "unknown");
  });

  it("does not invent explore/coder from free text", () => {
    assert.equal(canonicalizeRole("explore"), null);
    assert.equal(canonicalizeRole("coder"), null);
  });
});

describe("resolveRole", () => {
  it("prefers picker, then hod_role, then start name", () => {
    assert.deepEqual(
      resolveRole({ override: "tester", hodRole: "worker", name: "impl" }),
      { role: "tester", roleSource: "user" },
    );
    assert.deepEqual(
      resolveRole({ hodRole: "worker", name: "impl-1" }),
      { role: "worker", roleSource: "hod" },
    );
    assert.deepEqual(
      resolveRole({ name: "reviewer" }),
      { role: "review", roleSource: "name" },
    );
    assert.deepEqual(
      resolveRole({ kind: "lead" }),
      { role: "lead", roleSource: "lead" },
    );
  });

  it("never infers a role from ticket text", () => {
    const guessed = resolveRole({
      title: "Implement the patch and review the tester advisor explore search",
    });
    assert.equal(guessed.role, "unknown");
    assert.equal(guessed.roleSource, "unmapped");
  });
});

describe("ASSIGNABLE_ROLES", () => {
  it("includes Desktop impl plus HOD topology", () => {
    assert.deepEqual([...ASSIGNABLE_ROLES], ["lead", "worker", "impl", "review", "advisor", "tester"]);
  });
});

describe("parseRoleDirective", () => {
  it("parses an explicit user assignment in the prompt", () => {
    assert.deepEqual(parseRoleDirective("@reviewer grok check the diff"), {
      role: "review",
      who: "grok",
      task: "check the diff",
      alias: "reviewer",
    });
    assert.deepEqual(parseRoleDirective("@impl claude write the handler"), {
      role: "impl",
      who: "claude",
      task: "write the handler",
      alias: "impl",
    });
    assert.equal(parseRoleDirective("please review the explorer search"), null);
  });
});

describe("attachHerdrTeams", () => {
  it("copies hod_role from pane tokens when present", () => {
    const sessions = [
      { meta: { id: "sess-1", runtime: "claude", cwd: "/repo" } },
    ];
    const changed = attachHerdrTeams(sessions, [{
      kind: "claude",
      name: "advisor-1",
      paneId: "pane-1",
      tabId: "tab-1",
      sessionId: "sess-1",
      hodRole: "worker",
      hodRelation: "delegate",
      hodRun: "run-1",
      hodTask: "build",
      hodParent: "pane-0",
      status: "idle",
    }], { live: false });
    assert.deepEqual(changed, ["sess-1"]);
    assert.equal(sessions[0].meta.team.hodRole, "worker");
    assert.equal(sessions[0].meta.team.herdrName, "advisor-1");
    assert.equal(sessions[0].meta.team.herdrSessionId, "sess-1");
  });

  it("does not attach a later grok chat to a spawn just because cwd matches", () => {
    const sessions = [
      { meta: { id: "grok-worker", runtime: "grok", cwd: "/repo", mtimeMs: 1 } },
      { meta: { id: "grok-later", runtime: "grok", cwd: "/repo", mtimeMs: 9 } },
    ];
    attachHerdrTeams(sessions, [{
      kind: "grok",
      name: "reviewer-1",
      paneId: "pane-r",
      tabId: "tab-1",
      sessionId: null,
      cwd: "/repo",
      status: "idle",
    }, {
      kind: "grok",
      name: "worker-1",
      paneId: "pane-w",
      tabId: "tab-1",
      sessionId: null,
      cwd: "/repo",
      status: "idle",
    }], { live: false });
    assert.equal(sessions[0].meta.team, undefined);
    assert.equal(sessions[1].meta.team, undefined);
  });

  it("binds a spawn only to the transcript with the matching session id", () => {
    const sessions = [
      { meta: { id: "grok-later", runtime: "grok", cwd: "/repo", mtimeMs: 9 } },
      { meta: { id: "grok-review", runtime: "grok", cwd: "/repo", mtimeMs: 2 } },
    ];
    attachHerdrTeams(sessions, [{
      kind: "grok",
      name: "reviewer-1",
      paneId: "pane-r",
      tabId: "tab-1",
      sessionId: "grok-review",
      cwd: "/repo",
      status: "idle",
    }], { live: false });
    assert.equal(sessions[0].meta.team, undefined);
    assert.equal(sessions[1].meta.team.herdrName, "reviewer-1");
    assert.equal(sessions[1].meta.team.herdrSessionId, "grok-review");
  });

  it("keeps a local grok chat off the herdr team even on the same tab", () => {
    const sessions = [
      { meta: { id: "local-grok", runtime: "grok", cwd: "/repo" } },
      { meta: { id: "w-sess", runtime: "grok", cwd: "/repo" } },
      { meta: { id: "c-sess", runtime: "claude", cwd: "/repo" } },
    ];
    attachHerdrTeams(sessions, [
      { kind: "claude", name: "claude", paneId: "p-c", tabId: "tab-1", sessionId: "c-sess", cwd: "/repo", status: "idle" },
      { kind: "grok", name: "worker-1", paneId: "p-w", tabId: "tab-1", sessionId: "w-sess", cwd: "/repo", status: "idle" },
      { kind: "grok", name: "grok", paneId: "p-local", tabId: "tab-1", sessionId: "local-grok", cwd: "/repo", status: "idle" },
    ], { live: false });
    assert.equal(sessions[1].meta.team.herdrName, "worker-1");
    assert.match(sessions[1].meta.team.id, /^orch:/);
    assert.equal(sessions[0].meta.team.herdrName, "grok");
    assert.match(sessions[0].meta.team.id, /^pane:/);
    assert.notEqual(sessions[0].meta.team.id, sessions[1].meta.team.id);
  });

  it("binds grok spawns by terminal title when Herdr has no session id", () => {
    const sessions = [
      { meta: { id: "local-grok", runtime: "grok", cwd: "/repo", title: "How herdr-orchestrator Assigns Roles" } },
      { meta: { id: "w-sess", runtime: "grok", cwd: "/repo", title: "Create Agent Visualizer README.md File" } },
      { meta: { id: "r-sess", runtime: "grok", cwd: "/repo", title: "Incomplete Write Query Request" } },
      { meta: { id: "c-sess", runtime: "claude", cwd: "/repo" } },
    ];
    attachHerdrTeams(sessions, [
      { kind: "claude", name: "claude", paneId: "p-c", tabId: "tab-1", sessionId: "c-sess", cwd: "/repo", status: "idle" },
      {
        kind: "grok", name: "worker-1", paneId: "p-w", tabId: "tab-1", sessionId: null, cwd: "/repo",
        terminalTitle: "Create Agent Visualizer README.md File - grok", status: "idle",
      },
      {
        kind: "grok", name: "reviewer-1", paneId: "p-r", tabId: "tab-1", sessionId: null, cwd: "/repo",
        terminalTitle: "Incomplete Write Query Request - grok", status: "idle",
      },
    ], { live: false });
    assert.equal(sessions[0].meta.team, undefined);
    assert.equal(sessions[1].meta.team.herdrName, "worker-1");
    assert.equal(sessions[2].meta.team.herdrName, "reviewer-1");
    assert.equal(sessions[1].meta.team.id, sessions[2].meta.team.id);
    assert.match(sessions[1].meta.team.id, /^orch:/);
  });

  it("clears a stale reviewer bind from a different grok session", () => {
    const sessions = [
      { meta: { id: "local-grok", runtime: "grok", cwd: "/repo", team: { id: "orch:tab-1", herdrName: "reviewer-1", paneId: "p-r" } } },
    ];
    attachHerdrTeams(sessions, [
      { kind: "grok", name: "reviewer-1", paneId: "p-r", tabId: "tab-1", sessionId: "real-reviewer", cwd: "/repo", status: "idle" },
    ], { live: true });
    assert.equal(sessions[0].meta.team, undefined);
  });

  it("keeps worker and reviewer on the team after they leave Herdr", () => {
    const sessions = [
      { meta: { id: "c-sess", runtime: "claude", cwd: "/repo" } },
      { meta: { id: "w-sess", runtime: "grok", cwd: "/repo", title: "Create README" } },
      { meta: { id: "r-sess", runtime: "grok", cwd: "/repo", title: "Review README" } },
    ];
    const live = [
      { kind: "claude", name: "", paneId: "p-c", tabId: "tab-1", sessionId: "c-sess", cwd: "/repo", status: "idle" },
      {
        kind: "grok", name: "worker-1", paneId: "p-w", tabId: "tab-1", sessionId: "w-sess",
        cwd: "/repo", terminalTitle: "Create README - grok", status: "idle",
      },
      {
        kind: "grok", name: "reviewer-1", paneId: "p-r", tabId: "tab-1", sessionId: "r-sess",
        cwd: "/repo", terminalTitle: "Review README - grok", status: "idle",
      },
    ];
    attachHerdrTeams(sessions, live, { live: true });
    const family = sessions[0].meta.team.id;
    assert.match(family, /^orch:/);
    assert.equal(sessions[1].meta.team.herdrName, "worker-1");
    assert.equal(sessions[2].meta.team.herdrName, "reviewer-1");

    attachHerdrTeams(sessions, [live[0]], { live: true });
    assert.equal(sessions[0].meta.team.id, family);
    assert.equal(sessions[1].meta.team.id, family);
    assert.equal(sessions[2].meta.team.id, family);
    assert.equal(sessions[1].meta.team.herdrName, "worker-1");
    assert.equal(sessions[2].meta.team.herdrName, "reviewer-1");
    assert.equal(sessions[1].meta.team.exited, true);
    assert.equal(sessions[2].meta.team.exited, true);
    assert.equal(sessions[0].meta.team.exited, false);
  });

  it("does not invent teammates from copied herdr JSON in an unrelated tool result", () => {
    const sessions = [
      {
        meta: { id: "g-later", runtime: "grok", cwd: "/repo", title: "Missing Elements Inquiry" },
        events: [
          { kind: "tool_call", toolUseId: "x", toolName: "Bash", detail: '{"command":"python3 -c print()"}' },
          {
            kind: "tool_output", toolUseId: "x",
            detail: JSON.stringify({
              id: "cli:agent:start",
              result: {
                type: "agent_started",
                agent: { name: "worker-1", pane_id: "p-w", tab_id: "tab-1", agent: "grok" },
              },
            }),
          },
        ],
      },
    ];
    attachHerdrTeams(sessions, [], { live: true });
    assert.equal(sessions[0].meta.team, undefined);
  });

  it("rebuilds the team from herdr start/prompt in the lead transcript", () => {
    const sessions = [
      {
        meta: { id: "c-sess", runtime: "claude", cwd: "/repo" },
        events: [
          {
            kind: "tool_call", toolUseId: "1", toolName: "Bash",
            detail: JSON.stringify({ command: "herdr agent start worker-1 --kind grok --pane p-w" }),
          },
          {
            kind: "tool_output", toolUseId: "1",
            detail: JSON.stringify({
              id: "cli:agent:start",
              result: {
                type: "agent_started",
                agent: {
                  name: "worker-1", pane_id: "p-w", tab_id: "tab-1", agent: "grok",
                  terminal_title_stripped: "Create README - grok",
                },
              },
            }),
          },
          {
            kind: "tool_call", toolUseId: "2", toolName: "Bash",
            detail: JSON.stringify({ command: "herdr agent start reviewer-1 --kind grok --pane p-r" }),
          },
          {
            kind: "tool_output", toolUseId: "2",
            detail: JSON.stringify({
              id: "cli:agent:start",
              result: {
                type: "agent_started",
                agent: {
                  name: "reviewer-1", pane_id: "p-r", tab_id: "tab-1", agent: "grok",
                  terminal_title_stripped: "Review README - grok",
                },
              },
            }),
          },
        ],
      },
      { meta: { id: "w-sess", runtime: "grok", cwd: "/repo", title: "Create README" }, events: [] },
      { meta: { id: "r-sess", runtime: "grok", cwd: "/repo", title: "Review README" }, events: [] },
    ];
    attachHerdrTeams(sessions, [], { live: true });
    assert.equal(sessions[1].meta.team.herdrName, "worker-1");
    assert.equal(sessions[2].meta.team.herdrName, "reviewer-1");
    assert.equal(sessions[0].meta.team.id, sessions[1].meta.team.id);
    assert.match(sessions[0].meta.team.id, /^orch:/);
    assert.equal(sessions[1].meta.team.exited, true);
    assert.equal(sessions[2].meta.team.exited, true);
  });
});

function member({
  id, runtime = "claude", hodRole, roleOverride,
  startedAt = "2026-01-01T00:00:00Z", name = "", paneId = "", mtimeMs = 0,
  herdrSessionId = "", brief = "review the explorer search and implement a patch",
  outcome = "", currentWork = "", tickets = null,
}) {
  return {
    meta: {
      id,
      runtime,
      startedAt,
      mtimeMs,
      roleOverride,
      team: {
        herdrName: name,
        paneId,
        herdrSessionId: herdrSessionId || undefined,
        ...(hodRole ? { hodRole, role: hodRole } : {}),
      },
    },
    office: {
      brief,
      outcome,
      tickets: tickets || [{
        id: `brief-${id}`, title: brief, fromId: "user", toId: "lead",
        status: "doing", startTs: startedAt, endTs: null,
      }],
      people: [{ kind: "lead", currentWork: currentWork || brief, status: "doing" }],
    },
    heatmap: [],
  };
}

describe("mergeTeamView", () => {
  it("uses hod_role=controller as lead; token beats start name", () => {
    const view = mergeTeamView([
      member({ id: "w1", hodRole: "worker", name: "impl-1", startedAt: "2026-01-01T00:00:00Z" }),
      member({ id: "c1", hodRole: "controller", name: "lead", startedAt: "2026-01-01T00:01:00Z" }),
      member({ id: "r1", hodRole: "reviewer", name: "reviewer-1", startedAt: "2026-01-01T00:02:00Z" }),
    ]);
    const people = view.office.people;
    const lead = people.find((p) => p.kind === "lead");
    const staff = people.filter((p) => p.kind === "subagent");
    assert.equal(lead.sessionId, "c1");
    assert.equal(lead.roleHint, "lead");
    assert.equal(staff.find((p) => p.sessionId === "w1").roleHint, "worker");
    assert.equal(staff.find((p) => p.sessionId === "w1").roleSource, "hod");
    assert.equal(staff.find((p) => p.sessionId === "r1").roleHint, "review");
  });

  it("on Desktop 0.1.7, reads role from the start name the user chose", () => {
    const view = mergeTeamView([
      member({ id: "c1", name: "controller", startedAt: "2026-01-01T00:00:00Z" }),
      member({ id: "w1", name: "impl", startedAt: "2026-01-01T00:01:00Z" }),
      member({ id: "r1", name: "reviewer", startedAt: "2026-01-01T00:02:00Z" }),
    ]);
    const lead = view.office.people.find((p) => p.kind === "lead");
    const staff = view.office.people.filter((p) => p.kind === "subagent");
    assert.equal(lead.sessionId, "c1");
    assert.equal(staff.find((p) => p.sessionId === "w1").roleHint, "impl");
    assert.equal(staff.find((p) => p.sessionId === "w1").roleSource, "name");
    assert.equal(staff.find((p) => p.sessionId === "r1").roleHint, "review");
  });

  it("leaves names that are not a start-role unmapped", () => {
    const view = mergeTeamView([
      member({ id: "c1", name: "controller" }),
      member({ id: "x1", name: "review-bot" }),
    ]);
    const staff = view.office.people.find((p) => p.sessionId === "x1");
    assert.equal(staff.roleHint, "unknown");
    assert.equal(staff.roleSource, "unmapped");
  });

  it("picks the untagged Claude pane as lead over an earlier worker-1", () => {
    const view = mergeTeamView([
      member({ id: "g1", runtime: "grok", name: "worker-1", startedAt: "2026-01-01T00:00:00Z" }),
      member({ id: "c1", runtime: "claude", name: "", startedAt: "2026-01-01T00:01:00Z" }),
      member({ id: "r1", runtime: "grok", name: "reviewer-1", startedAt: "2026-01-01T00:02:00Z" }),
    ]);
    const lead = view.office.people.find((p) => p.kind === "lead");
    const staff = view.office.people.filter((p) => p.kind === "subagent");
    assert.equal(lead.sessionId, "c1");
    assert.equal(lead.runtime, "claude");
    assert.equal(staff.length, 2);
    assert.equal(staff.find((p) => p.sessionId === "g1").roleHint, "worker");
    assert.equal(staff.find((p) => p.sessionId === "r1").roleHint, "review");
  });

  it("collapses extra session files for the same worker pane into one desk", () => {
    const view = mergeTeamView([
      member({ id: "c1", runtime: "claude", name: "", paneId: "pane-lead" }),
      member({ id: "g-old", runtime: "grok", name: "worker-1", paneId: "pane-w", mtimeMs: 1 }),
      member({ id: "g-mid", runtime: "grok", name: "worker-1", paneId: "pane-w", mtimeMs: 2 }),
      member({ id: "g-new", runtime: "grok", name: "worker-1", paneId: "pane-w", mtimeMs: 3 }),
      member({ id: "r1", runtime: "grok", name: "reviewer-1", paneId: "pane-r" }),
    ]);
    const staff = view.office.people.filter((p) => p.kind === "subagent");
    assert.equal(view.office.people.length, 3);
    assert.equal(staff.length, 2);
    assert.equal(staff.filter((p) => p.roleHint === "worker").length, 1);
    assert.equal(staff.find((p) => p.roleHint === "worker").sessionId, "g-new");
    assert.equal(staff.find((p) => p.roleHint === "review").sessionId, "r1");
  });

  it("keeps each spawn's own transcript, not a newer chat on the same pane", () => {
    const view = mergeTeamView([
      member({
        id: "c1", runtime: "claude", name: "", paneId: "pane-lead",
        brief: "Use Herdr. Three panes.",
      }),
      member({
        id: "g-worker", runtime: "grok", name: "worker-1", paneId: "pane-w",
        herdrSessionId: "g-worker",
        brief: "Tạo/ghi đè file README.md mô tả ngắn gọn dự án.",
        outcome: "Đã ghi đè README.md (~27 dòng).",
        mtimeMs: 2,
      }),
      member({
        id: "g-review", runtime: "grok", name: "reviewer-1", paneId: "pane-r",
        herdrSessionId: "g-review",
        brief: "Review file README.md. Check nội dung.",
        outcome: "README 26 dòng, mô tả đúng dự án.",
        mtimeMs: 3,
      }),
      member({
        id: "g-later", runtime: "grok", name: "reviewer-1", paneId: "pane-r",
        herdrSessionId: "g-review",
        brief: "co phai chay lai server k",
        outcome: "Co. Logic chon lead nam o server.",
        mtimeMs: 99,
      }),
    ]);
    const staff = view.office.people.filter((p) => p.kind === "subagent");
    const worker = staff.find((p) => p.herdrName === "worker-1");
    const reviewer = staff.find((p) => p.herdrName === "reviewer-1");
    assert.equal(staff.length, 2);
    assert.match(worker.currentWork, /README\.md/);
    assert.doesNotMatch(worker.currentWork, /Review file/);
    assert.match(reviewer.currentWork, /26 dòng|đúng dự án/);
    assert.doesNotMatch(reviewer.currentWork, /chon lead|chay lai server/i);
    const tasks = view.office.people[0].assignments.map((a) => a.task).join("\n");
    assert.match(tasks, /Tạo\/ghi đè file README/);
    assert.match(tasks, /Review file README/);
    assert.doesNotMatch(tasks, /chay lai server/i);
  });

  it("lists every user request on a spawn desk, not only the last one", () => {
    const view = mergeTeamView([
      member({ id: "c1", runtime: "claude", name: "", paneId: "pane-lead" }),
      member({
        id: "g-worker", runtime: "grok", name: "worker-1", paneId: "pane-w",
        herdrSessionId: "g-worker",
        brief: "Tạo README.md",
        tickets: [
          { id: "t1", title: "Tạo README.md", fromId: "user", toId: "lead", status: "done", result: "Đã ghi README.md" },
          { id: "t2", title: "Sửa mô tả cho ngắn hơn", fromId: "user", toId: "lead", status: "done", result: "Đã rút ngắn mô tả" },
          { id: "t3", title: "Tạo file HELLO.MD với hello world", fromId: "user", toId: "lead", status: "doing", result: "Đã tạo HELLO.MD" },
        ],
      }),
      member({ id: "r1", runtime: "grok", name: "reviewer-1", paneId: "pane-r" }),
    ]);
    const worker = view.office.people.find((p) => p.herdrName === "worker-1");
    assert.equal(worker.tasks.length, 3);
    assert.deepEqual(worker.tasks.map((t) => t.title), [
      "Tạo README.md",
      "Sửa mô tả cho ngắn hơn",
      "Tạo file HELLO.MD với hello world",
    ]);
    const leadTasks = view.office.people[0].assignments
      .filter((a) => a.who.toLowerCase().includes("worker"))
      .map((a) => a.task);
    assert.equal(leadTasks.length, 3);
    assert.equal(worker.tasks[0].result, "Đã ghi README.md");
    assert.equal(worker.tasks[2].result, "Đã tạo HELLO.MD");
  });
});

describe("buildOffice herdr history", () => {
  it("keeps worker and reviewer desks after herdr start/prompt finish", () => {
    const office = buildOffice([
      { kind: "user_prompt", id: "u1", ts: "t0", detail: "Use Herdr. Bật đúng 3 pane." },
      {
        kind: "tool_call", id: "c1", toolUseId: "1", toolName: "Bash", ts: "t1",
        detail: JSON.stringify({ command: "herdr agent start worker-1 --kind grok --pane p-w" }),
      },
      {
        kind: "tool_output", id: "o1", toolUseId: "1", ts: "t2",
        detail: JSON.stringify({
          id: "cli:agent:start",
          result: { type: "agent_started", agent: { name: "worker-1", pane_id: "p-w", tab_id: "t1", agent: "grok" } },
        }),
      },
      {
        kind: "tool_call", id: "c2", toolUseId: "2", toolName: "Bash", ts: "t3",
        detail: JSON.stringify({ command: "herdr agent start reviewer-1 --kind grok --pane p-r" }),
      },
      {
        kind: "tool_output", id: "o2", toolUseId: "2", ts: "t4",
        detail: JSON.stringify({
          id: "cli:agent:start",
          result: { type: "agent_started", agent: { name: "reviewer-1", pane_id: "p-r", tab_id: "t1", agent: "grok" } },
        }),
      },
      {
        kind: "tool_call", id: "c3", toolUseId: "3", toolName: "Bash", ts: "t5",
        detail: JSON.stringify({ command: "herdr agent prompt worker-1 'Tạo file HELLO.MD với hello world' --wait" }),
      },
      {
        kind: "tool_output", id: "o3", toolUseId: "3", ts: "t6",
        detail: JSON.stringify({
          id: "cli:agent:prompt",
          result: { type: "agent_prompted", agent: { name: "worker-1", agent_status: "idle" } },
        }),
      },
    ]);
    const worker = office.people.find((p) => p.herdrName === "worker-1");
    const reviewer = office.people.find((p) => p.herdrName === "reviewer-1");
    assert.ok(worker);
    assert.ok(reviewer);
    assert.equal(worker.roleHint, "worker");
    assert.equal(reviewer.roleHint, "review");
    assert.equal(worker.runtime, "grok");
    assert.equal(worker.status, "done");
    assert.match(worker.tasks[0].title, /HELLO/);
    assert.equal(office.counts.people, 3);
  });

  it("does not create a desk for a timed-out herdr start", () => {
    const office = buildOffice([
      { kind: "user_prompt", id: "u1", ts: "t0", detail: "start worker" },
      {
        kind: "tool_call", id: "c1", toolUseId: "1", toolName: "Bash", ts: "t1",
        detail: JSON.stringify({ command: "herdr agent start worker-1 --kind grok --pane p-w" }),
      },
      {
        kind: "tool_error", id: "o1", toolUseId: "1", ts: "t2",
        detail: JSON.stringify({ error: { code: "timeout" }, id: "cli:agent:start" }),
      },
    ]);
    assert.equal(office.people.some((p) => p.herdrName === "worker-1"), false);
    assert.equal(office.people.length, 1);
  });
});
