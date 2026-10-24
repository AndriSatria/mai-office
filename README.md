# ▣ Virtual Harness

A pixel-art office where every **Claude Code** agent is an animated little person at its own desk.
Click a person, type to them, and your message goes to that agent's Claude Code session; the reply streams back
into a chat panel and a speech bubble over their head.

![office](screenshots/06-done-with-reply-bubble.png)

* **Backend:** Node.js, `express` + `ws`. **Frontend:** one HTML page + plain `<canvas>`, no build step.
* **Art:** 100% procedural (`fillRect` on a 384×240 logical canvas, integer / half-step upscaling with
  `imageSmoothingEnabled = false`). No assets.
* **Modes:** `claude` (real Claude Code CLI, headless) or `mock` (simulated agents so you can demo the UI).

## Run

```bash
npm install
npm start            # http://127.0.0.1:3000  (PORT=4000 npm start to change the port)
```

Mode is picked automatically: `claude` if a `claude` binary is on `PATH`, otherwise `mock`.
Force one with `HARNESS_MODE`:

```bash
HARNESS_MODE=mock   npm start      # simulated agents, no Claude needed
HARNESS_MODE=claude npm start      # real Claude Code (needs `claude` installed & logged in)
```

### Using it

| Action | How |
| --- | --- |
| Select an agent | Click the person (or their desk). Chat panel opens on the right. |
| Talk to it | Type in the box, **Enter** to send (Shift+Enter = newline). Messages sent while it's busy are queued. |
| Hire | **＋ Hire agent** (or click an empty desk): name + working directory. Up to 8 desks. |
| Fire | Select an agent, **✖ Fire agent**. |
| Stop a run | **■ Stop** in the chat panel (kills the CLI process). |

Agent states and what you see:

| State | Trigger | Visuals |
| --- | --- | --- |
| idle | nothing running | subtle bob + blinking; may wander to the coffee corner (pass `?wander=off` to disable, `?wander=fast` to demo) |
| thinking | run started / waiting on model | thought bubble with animated dots, hand on chin |
| working | tool use or streaming text | typing arms, flickering code on the monitor, green chip with the tool name (`Bash`, `Edit`, …) |
| done | `result` event | green ✓, sparkles, arms up, smiling |
| error | CLI/run error | red `!`, worried face, red monitor, error shown in chat + bubble |

## Claude mode details

For every message the server spawns (cwd = the agent's working directory):

```
claude -p --output-format stream-json --verbose --permission-mode acceptEdits \
       [--resume <session_id>] [--include-partial-messages] -- "<your message>"
```

The first run's `system/init` (or `result`) event gives a `session_id`, stored on the agent (and persisted), and
passed to `--resume` on later messages so the conversation continues. Parsed events:

* `assistant` → `text` blocks become chat replies; `tool_use` blocks → **working** + tool label + a `▸ Tool: summary` line
* `user` → `tool_result` → back to **thinking**
* `stream_event` text deltas (only with `HARNESS_PARTIAL=1`) → live token streaming
* `result` → **done** (or **error** if `is_error`)

Environment knobs:

| Var | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | HTTP/WebSocket port |
| `HOST` | `127.0.0.1` | bind address (keep it loopback unless you know what you're doing) |
| `HARNESS_MODE` | auto | `claude` or `mock` |
| `HARNESS_CLAUDE_BIN` | `claude` on PATH | path to the CLI |
| `HARNESS_PERMISSION_MODE` | `acceptEdits` | passed as `--permission-mode`; `none` omits the flag. Headless runs can't answer permission prompts, so tools not pre-approved are denied — add e.g. `HARNESS_CLAUDE_ARGS="--allowedTools Bash,Read,Edit"` |
| `HARNESS_CLAUDE_ARGS` | – | extra whitespace-separated CLI args (`--model sonnet` …) |
| `HARNESS_PARTIAL` | off | `1` adds `--include-partial-messages` |
| `HARNESS_DATA` | `data/agents.json` | where agents + transcripts + session ids are persisted |
| `HARNESS_DEFAULT_CWD` | server cwd | default working dir in the Hire dialog |

> ⚠️ **Claude mode is untested against a real CLI.** It was written from the documented flags; `claude` was not
> installed where this prototype was built. It *was* exercised end-to-end (state machine, `--resume` capture,
> tool labels) with `scripts/fake-claude.js`, a stand-in that emits the documented stream-json shape:
> `HARNESS_MODE=claude HARNESS_CLAUDE_BIN=$PWD/scripts/fake-claude.js npm start`.
> Run `claude --help` and adjust `lib/adapters/claude.js` if your CLI version differs.

## Security notes

The server can make Claude Code run in any directory you give it. It binds to loopback by default and rejects
cross-origin WebSocket connections, but there is **no authentication** — don't expose it to a network.

## Project layout

```
server.js                 express static + WebSocket hub
lib/harness.js            agent registry, state machine, persistence, message queue
lib/adapters/claude.js    Claude Code CLI adapter (stream-json)
lib/adapters/mock.js      simulated agent
lib/adapters/index.js     mode selection
public/index.html, style.css
public/js/office.js       procedural pixel-art renderer (scene, characters, bubbles)
public/js/app.js          WebSocket client, chat panel, wandering logic
scripts/screenshots.js    Playwright demo: hires, chats, screenshots → screenshots/
scripts/fake-claude.js    fake `claude` binary for adapter testing
```

WebSocket protocol — client→server: `hire {name,cwd}`, `fire {id}`, `send {id,text}`, `interrupt {id}`;
server→client: `snapshot`, `agent` (state/tool updates), `removed`, `msg`, `msg_update` (streamed text), `error`.

## Regenerate screenshots

```bash
npm install && npx playwright install chromium
npm run screenshots
```

## Known limitations / ideas

* Max 8 agents (desk slots); fixed office layout; characters only face front.
* Claude mode untested with real CLI; no tool-permission prompts in headless mode; one process per message.
* No auth; no markdown rendering in chat; long transcripts are capped at 300 messages per agent.
* Next: agent-to-agent messaging, `/clear`/new-session button, per-agent model & permission settings,
  markdown/diff rendering, sound, day/night cycle, a meeting room for multi-agent tasks.
