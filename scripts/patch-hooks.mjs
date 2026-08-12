#!/usr/bin/env node
// Patch ~/.claude/settings.json by adding HTTP hooks for Agent Visualizer.
// NEVER log the file contents (it may contain ANTHROPIC_AUTH_TOKEN).
// Safe merge: preserve env keys and existing hooks, remain idempotent, write atomically.
// Run: node scripts/patch-hooks.mjs (then restart Claude Code).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SETTINGS = path.join(os.homedir(), ".claude", "settings.json");
const HOOK_URL = process.env.VISUAL_HOOK_URL || "http://127.0.0.1:3002/api/v1/hooks";

// Hooks to add for the visualizer.
const EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "UserPromptSubmit",
  "Stop",
  "SubagentStop",
  "PreCompact",
  "Notification",
  "SessionEnd",
];

function alreadyHasHook(hooksArr, url) {
  return (
    Array.isArray(hooksArr) &&
    hooksArr.some((group) =>
      group?.hooks?.some((h) => h?.type === "http" && h?.url === url),
    )
  );
}

export function patchHooks() {
  if (!fs.existsSync(SETTINGS)) {
    console.error(`Settings file not found: ${SETTINGS}`);
    process.exit(1);
  }

  // Read and parse without changing the existing structure.
  const raw = fs.readFileSync(SETTINGS, "utf8");
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (err) {
    console.error("settings.json contains invalid JSON:", err.message);
    process.exit(1);
  }

  const hooks = obj.hooks || (obj.hooks = {});
  let added = 0;
  for (const ev of EVENTS) {
    const arr = hooks[ev] || (hooks[ev] = []);
    if (alreadyHasHook(arr, HOOK_URL)) continue;
    arr.push({ matcher: "*", hooks: [{ type: "http", url: HOOK_URL, timeout: 5 }] });
    added++;
  }

  if (added === 0) {
    console.log("Hooks already exist — no changes made.");
    console.log("Reminder: restart Claude Code to load the hooks.");
    return;
  }

  // Atomic write — temp file + rename
  const tmp = SETTINGS + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  fs.renameSync(tmp, SETTINGS);

  console.log(`Added ${added} HTTP hook(s) → ${HOOK_URL}`);
  console.log("Preserved: env keys, model, theme, and existing hooks.");
  console.log("⚠  RESTART Claude Code to load the hooks (hooks load at session start).");
  console.log("⚠  settings.json contents are never displayed (it may contain an API key).");
}

// Main guard — runs when invoked directly with `node scripts/patch-hooks.mjs`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  patchHooks();
}
