#!/usr/bin/env node
// Herdr action: start the visualizer if needed, then open the dashboard.
import { execSync, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.env.HERDR_PLUGIN_ROOT
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.VISUAL_PORT || process.env.REALTIME_PORT) || 3002;
const BASE = `http://127.0.0.1:${PORT}`;

async function isHealthy() {
  try {
    const r = await fetch(`${BASE}/api/v1/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

function openBrowser(url) {
  try {
    if (process.platform === "darwin") execSync(`open "${url}"`);
    else if (process.platform === "win32") execSync(`start "" "${url}"`);
    else execSync(`xdg-open "${url}"`);
  } catch { /* print URL below */ }
}

function startDetached() {
  const server = path.join(ROOT, "server", "realtime.mjs");
  const child = spawn(process.execPath, [server], {
    cwd: ROOT,
    env: { ...process.env, VISUAL_PORT: String(PORT) },
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

if (!(await isHealthy())) {
  startDetached();
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (await isHealthy()) break;
  }
}

if (await isHealthy()) {
  console.log(`Agent Visualizer → ${BASE}`);
  openBrowser(BASE);
  process.exit(0);
}

console.error(`Could not start Agent Visualizer at ${BASE}`);
process.exit(1);
