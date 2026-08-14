# Agent Visualizer

Agent Visualizer is a tool for **observing and analyzing Agent Flows** from Claude Code and Codex.
It reads local JSONL sessions, normalizes their events, and displays the execution process in a local dashboard.

The observable flow is:

```text
User Prompt → Agent → Tool → Result/Error → Response
```

This is not an AI Agent engine and does not orchestrate work. Claude Code or Codex remains responsible for execution; Agent Visualizer helps inspect, debug, and analyze what happened. The application does not call an AI API or send data to an external server.

## Features

- Monitor multiple Claude Code and Codex sessions.
- Receive realtime updates through file watching, Claude HTTP hooks, and SSE.
- Use the Execution Graph to visualize prompts, agents, tools, subagents, and errors.
- Hide technical nodes to keep the graph readable.
- Drag nodes, pan the canvas, and zoom the graph with the mouse wheel.
- Click a node to inspect its tool, turn, agent, and detailed content.
- Use the file heatmap to see which files are read, written, or edited most often.
- Read the message log between the user, agent, and tools.
- View metrics for tool calls, tokens, duration, files, and errors.
- Replay old Claude Code or Codex sessions from JSONL files.
- Redact selected API keys, tokens, and secrets before display.
- Run locally at `127.0.0.1` with a lightweight asset build.

## Use Cases

Agent Visualizer is useful for:

- Debugging when an AI agent edits code incorrectly or calls the wrong tool.
- Checking which files an agent read or changed.
- Analyzing a complex Agent Flow step by step.
- Evaluating time, tool-call count, and token cost.
- Training new team members with replayable example sessions.
- Monitoring multiple Claude Code or Codex sessions at once.
- Building evaluation and observability systems for AI Agents.

## Requirements

- Node.js 18 or newer.
- Claude Code or Codex if you want to monitor real sessions.

Check your Node.js version:

```bash
node --version
```

## Install from npm

This method is available after `agent-visualizer` has been published to npm. `npx` downloads the published package; it does not run the source code in your current clone.

No repository clone is required after publication:

```bash
npx agent-visualizer
```

The command starts the server and opens a browser. If the browser does not open automatically, visit:

```text
http://127.0.0.1:3002
```

Stop the server with `Ctrl+C`.

### Install with npm

Install the package into another local Node.js project:

```bash
mkdir my-agent-visualizer
cd my-agent-visualizer
npm init -y
npm install agent-visualizer
npx agent-visualizer
```

The package exposes the `visualizer` command. After installation, you can also run:

```bash
npm exec visualizer
```

The package postinstall script may install the Claude Code skill automatically. To skip lifecycle scripts in CI or another controlled environment, use `npm install agent-visualizer --ignore-scripts`.

### Global Installation

```bash
npm install --global agent-visualizer
visualizer
```

The package may install the Claude Code skill automatically. To install it manually:

```bash
visualizer install-skill
```

The skill is installed at:

```text
~/.claude/skills/agent-visualizer/SKILL.md
```

Restart Claude Code, then use:

```text
/agent-visualizer
```

## Build and Run from Source

```bash
git clone <repository-url>
cd claude-session-viewer
npm install
npm run build
npm start
```

`npm run build` bundles the local D3 runtime files into `public/`. This project does not use a frontend framework or a full bundler; the build step only prepares the browser assets.

The `prepare` lifecycle also runs this build automatically when installing from a cloned repository. Run `npm run build` explicitly when you want to rebuild the browser assets.

The default port is `3002`. Change it with:

```bash
VISUAL_PORT=4000 npm start
```

### Install the Local Package Globally

If you want to use the cloned source through the `visualizer` command:

```bash
npm install
npm run build
npm install --global .
visualizer
```

After the package is published to npm, use the package name instead of the local path:

```bash
npm install --global agent-visualizer
visualizer
```

## Realtime Monitoring

No extra configuration is required. The server automatically reads new or growing session files approximately every 800ms.

To let Claude Code send events directly through HTTP hooks:

```bash
visualizer patch-hooks
```

When running from source:

```bash
node scripts/patch-hooks.mjs
```

Restart Claude Code after patching so the hooks load. Hooks send events to:

```text
http://127.0.0.1:3002/api/v1/hooks
```

The script preserves the existing `~/.claude/settings.json` configuration and never prints the file contents to the terminal.

## Replay JSONL

Replay a Claude Code transcript:

```bash
visualizer replay /Users/your-name/.claude/projects/.../session-id.jsonl
```

Replay a Codex rollout:

```bash
visualizer replay /Users/your-name/.codex/sessions/2026/08/12/rollout-....jsonl --runtime codex
visualizer replay /Users/your-name/.grok/sessions/.../updates.jsonl --runtime grok
```

You can also open the `Replay` tab in the dashboard, select a runtime, paste the file path, and run it.

## Data Sources

Agent Visualizer reads only these local sources:

```text
~/.claude/projects/**/*.jsonl
~/.codex/sessions/**/rollout-*.jsonl
~/.grok/sessions/**/updates.jsonl
```

The sidebar filter is All / Claude / Codex / Other. Grok and any runtime that is not Claude or Codex appear under Other.

Claude transcripts and Codex rollouts are converted into a common event format so the graph, heatmap, message log, and metrics can process them consistently.

## Local API

| Route | Purpose |
|---|---|
| `GET /` | Dashboard |
| `GET /api/v1/health` | Check server health |
| `GET /api/v1/sessions` | List sessions |
| `GET /api/v1/sessions/:id` | Get session details |
| `GET /api/v1/stream` | Realtime SSE stream |
| `POST /api/v1/hooks` | Receive Claude Code hook events |
| `POST /api/v1/watch` | Track or replay a JSONL file |

All APIs bind only to `127.0.0.1`.

## Project Structure

- `server/realtime.mjs`: local server, watcher, hooks, SSE, and API.
- `server/transcript.mjs`: reads and normalizes Claude Code transcripts.
- `server/codex.mjs`: reads Codex rollouts.
- `server/grok.mjs`: reads Grok sessions (`updates.jsonl`).
- `server/visual.mjs`: builds the graph, heatmap, messages, and metrics.
- `public/app.js`: dashboard logic, graph rendering, and user interactions.
- `public/style.css`: dashboard styling.
- `bin/visualizer.mjs`: CLI for starting the server, replaying sessions, and installing the skill.
- `SKILL.md`: instructions that teach Claude Code how to use the tool.

## CLI Commands

| Command | Purpose |
|---|---|
| `npx agent-visualizer` | Start the dashboard |
| `visualizer` | Start the dashboard after global installation |
| `visualizer install-skill` | Install the skill into Claude Code |
| `visualizer patch-hooks` | Enable HTTP hooks for Claude Code |
| `visualizer replay <path>` | Replay a Claude JSONL file |
| `visualizer replay <path> --runtime codex` | Replay a Codex JSONL file |
| `visualizer replay <path> --runtime grok` | Replay a Grok `updates.jsonl` file |

## Troubleshooting

### Port already in use

```bash
VISUAL_PORT=4000 npx agent-visualizer
```

### No sessions appear

Check that the server is running, the data directories exist, and wait a few seconds for the watcher to read the files:

```text
Claude Code: ~/.claude/projects/
Codex:      ~/.codex/sessions/
Grok:       ~/.grok/sessions/
```

### Hooks do not update in realtime

Restart Claude Code after running `patch-hooks`, because hooks load when a session starts. Check the server at:

```text
http://127.0.0.1:3002/api/v1/health
```
