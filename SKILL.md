---
name: agent-visualizer
description: Open Agent Visualizer in realtime (execution graph, file heatmap, message log, and metrics) for Claude Code and Codex sessions. Use it to monitor or debug a running session.
---

# Agent Visualizer

Agent Visualizer is an observability tool for Claude Code and Codex Agent Flows. It reads local JSONL sessions and displays an execution graph, file heatmap, message log, and metrics. It runs entirely locally (bound to `127.0.0.1`), does not call a model, and does not send data anywhere.

## Getting Started

```bash
npx agent-visualizer
```

The browser opens `http://127.0.0.1:3002`. The sidebar lists Claude Code and Codex sessions and updates in realtime through SSE without a refresh. Select a session to view its graph, file heatmap, message log, and metrics.

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
