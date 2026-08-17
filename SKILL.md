---
name: agent-visualizer
description: Open Agent Visualizer in realtime (execution graph, file heatmap, message log, and metrics) for Claude Code, Codex, and Grok sessions. Use it to monitor or debug a running session.
---

# Agent Visualizer

Agent Visualizer is an observability tool for Claude Code, Codex, and Grok Agent Flows. It reads local JSONL sessions and displays an office floor (who is working, what they are processing, handoffs), plus an execution graph, file heatmap, message log, and metrics. It runs entirely locally (bound to `127.0.0.1`), does not call a model, and does not send data anywhere. The sidebar lists every local session together.

## Getting Started

```bash
npx agent-visualizer
```

The browser opens `http://127.0.0.1:3002`. The sidebar lists Claude Code and Codex sessions and updates in realtime through SSE without a refresh. Select a session to view its office floor, graph, file heatmap, message log, and metrics. Click a desk to inspect that agent and filter files/graph to their work.

Inside Herdr 0.8+:

```bash
# clone
cd /path/to/agent-session-viewer
npm install && npm run build
herdr plugin link "$PWD" --enabled

# hoặc đã cài global
npm install --global agent-visualizer
visualizer herdr-link

herdr plugin pane open --plugin agent.visualizer --entrypoint agent-visualizer --direction down
herdr plugin action invoke agent.visualizer.open
```

## Zero-Latency Hooks (Optional)

The tool works without hooks because the server tails transcripts roughly every 800ms. For immediate events:

```bash
npx agent-visualizer patch-hooks
```

Then **restart Claude Code** so the hooks load at session start. Hooks send events to `http://127.0.0.1:3002/api/v1/hooks`. The tool NEVER prints the contents of `settings.json` (which may contain an API key).

## Replay JSONL

```bash
npx agent-visualizer replay ~/.claude/projects/-Users-.../session.jsonl
npx agent-visualizer replay ~/.codex/sessions/2026/.../rollout-....jsonl --runtime codex
npx agent-visualizer replay ~/.grok/sessions/.../updates.jsonl --runtime grok
```

Alternatively, open the **Replay** tab, paste the file path, and click ▶.

## Key URLs

- `GET /` — dashboard
- `GET /api/v1/health` — server health
- `GET /api/v1/sessions` — session list
- `GET /api/v1/sessions/:id` — session details (graph/heatmap/messages/metrics)
- `POST /api/v1/watch` — track or replay a JSONL file
- `GET /api/v1/stream` — realtime SSE
- `POST /api/v1/hooks` — receive Claude Code HTTP hooks

## Requirements

Node 18+. Binds to `127.0.0.1`. Change the port with `VISUAL_PORT=4000` (also set `VISUAL_HOOK_URL` for `patch-hooks`). Install this skill into `~/.claude/skills` with:

```bash
npx agent-visualizer install-skill
```
