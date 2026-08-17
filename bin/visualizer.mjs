#!/usr/bin/env node
// Agent Visualizer CLI — start server + open browser, install-skill, patch-hooks, replay.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { patchHooks } from "../scripts/patch-hooks.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.VISUAL_PORT || process.env.REALTIME_PORT) || 3002;
const BASE = `http://127.0.0.1:${PORT}`;

function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    if (process.platform === "win32") execSync(`start "" "${url}"`);
    else execSync(`${cmd} "${url}"`);
  } catch { /* Browser launch failed; print the URL instead. */ }
}

async function isHealthy() {
  try {
    const r = await fetch(`${BASE}/api/v1/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}

// ---------- start ----------
async function cmdStart() {
  if (await isHealthy()) {
    console.log(`Server is already running at ${BASE} — reusing it.`);
    openBrowser(BASE);
    return;
  }
  console.log(`Starting Agent Visualizer → ${BASE} (Ctrl+C to stop)`);
  const server = path.join(ROOT, "server", "realtime.mjs");
  const child = spawn(process.execPath, [server], {
    cwd: ROOT,
    env: { ...process.env, VISUAL_PORT: String(PORT) },
    stdio: "inherit",
  });
  // Wait for the health endpoint.
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (await isHealthy()) break;
  }
  if (await isHealthy()) {
    console.log(`✓ ${BASE}`);
    openBrowser(BASE);
  } else {
    console.error(`✗ Server did not start at ${BASE} after 5s. Check the errors above.`);
    process.exitCode = 1;
  }
  child.on("exit", (code) => process.exit(code ?? 0));
}

function herdrBin() {
  return process.env.HERDR_BIN_PATH || process.env.HERDR_BIN || "herdr";
}

function runHerdr(args) {
  const r = spawnSync(herdrBin(), args, { cwd: ROOT, stdio: "inherit" });
  if (r.error?.code === "ENOENT") {
    console.error("herdr not found on PATH. Install Herdr 0.8+ first: https://herdr.dev");
    process.exit(1);
  }
  if (r.status) process.exit(r.status);
}

function cmdHerdrLink() {
  console.log(`Linking ${ROOT} as Herdr plugin agent.visualizer`);
  runHerdr(["plugin", "link", ROOT, "--enabled"]);
  runHerdr(["plugin", "list"]);
  console.log("Open:");
  console.log("  herdr plugin action invoke agent.visualizer.open");
  console.log("  herdr plugin pane open --plugin agent.visualizer --entrypoint agent-visualizer --direction down");
}

function cmdHerdrUnlink() {
  runHerdr(["plugin", "unlink", "agent.visualizer"]);
}

// ---------- install-skill ----------
function cmdInstallSkill() {
  const src = path.join(ROOT, "SKILL.md");
  if (!fs.existsSync(src)) {
    console.error("SKILL.md not found — package is incomplete.");
    process.exit(1);
  }
  const dir = path.join(os.homedir(), ".claude", "skills", "agent-visualizer");
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(src, path.join(dir, "SKILL.md"));
  console.log(`✓ Skill installed: ${dir}`);
  console.log("Restart Claude Code to load the skill. Use /agent-visualizer to launch it.");
}

// ---------- replay ----------
async function cmdReplay(filePath, runtime) {
  if (!await isHealthy()) await cmdStart();
  const r = await fetch(`${BASE}/api/v1/watch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ runtime: runtime || undefined, path: filePath }),
  });
  const j = await r.json();
  if (!r.ok || !j.id) {
    console.error("Replay failed:", j.error || r.status);
    process.exit(1);
  }
  console.log(`✓ Replay session ${j.id}`);
  openBrowser(`${BASE}/?_sess=${encodeURIComponent(j.id)}`);
}

// ---------- main ----------
const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case "herdr-link":
  case "install-herdr":
    cmdHerdrLink();
    break;
  case "herdr-unlink":
    cmdHerdrUnlink();
    break;
  case "install-skill":
    cmdInstallSkill();
    break;
  case "patch-hooks":
    patchHooks();
    break;
  case "replay": {
    const p = args[0];
    const rtIdx = args.indexOf("--runtime");
    const runtime = rtIdx >= 0 ? args[rtIdx + 1] : undefined;
    if (!p) { console.error("Usage: visualizer replay <path> [--runtime claude|codex|grok]"); process.exit(1); }
    await cmdReplay(p, runtime);
    break;
  }
  default:
    await cmdStart();
}
