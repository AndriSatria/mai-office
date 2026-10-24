# ▣ mAI office

**mAI office** is a pixel-art office where every **Claude Code** / **Cursor** agent is an animated little person at its own desk.
Click a person, type to them, and your message goes to that agent's Claude Code session; the reply streams back
into a chat panel and a speech bubble over their head.

![office](screenshots/06-done-with-reply-bubble.png)

* **Backend:** Node.js, `express` + `ws`. **Frontend:** one HTML page + plain `<canvas>`, no build step.
* **Art:** 100% procedural pixel-art **isometric (2:1 dimetric)** office drawn on a 400×264 logical `<canvas>`
  and upscaled by a whole-number factor with `imageSmoothingEnabled = false`. No assets. (`?view=flat` = the old top-down view.)
* **Agent types** (chosen per agent when hiring): `claude` (Claude Code CLI), `cursor` (Cursor CLI agent) or `mock`
  (simulated, no CLI). Each agent shows a small type badge under its name and in the chat header.
* **Lively idle agents:** idle people stretch, read, look around, sip coffee, or meet up for a chat by the coffee machine.

## Isometric view

The office is a 12×12 tile room seen from the south: diamond tile floor (32×16 px tiles), two back walls (windows,
wall clock, posters, whiteboard, a shelf with a CAFE sign), up to 8 desks in two rows (monitor, keyboard, mug, lamp,
drawers, chair), plants, and a coffee corner (counter, machine, kettle, mugs, rug).

* **Projection:** `sx = ox + (x − y)·16`, `sy = oy + (x + y)·8 − z`. +x runs down-right, +y down-left. Everything is
  drawn with `fillRect` / a tiny pixel-exact polygon filler, so edges are crisp and neighbouring faces never leave gaps.
  The canvas is scaled by an **integer** factor only (×3 at 1600×900).
* **Characters** are drawn in a 3/4 view with **4 facings** (SE, SW, NW, NE; two are mirrored versions of the others,
  and back views show the back of the head). All states and idle activities work in every facing: idle bob, thinking
  (hand on chin + dots), working (typing + tool chip + live monitor), done (arms up, ✓), error (`!`, red monitor),
  stretch, read, look around, coffee sip, and the two-person chat on the rug.
* **Walking:** agents walk on the tile grid. `walkPath(slot, spot)` is a 4-neighbour BFS over a `blocked[y][x]` grid
  (desks, chairs, counter, plants), so they never cut through furniture; the facing follows the walking direction.
* **Depth sorting:** objects (chairs, desks, plants, people) have tile footprints; an object is drawn before another when
  it lies fully behind it along x or y, falling back to tile x+y. The same painter order, reversed, drives hit testing,
  so the front-most thing under the cursor wins (a walker in front of a desk beats the desk).
* **Hover / selection:** an isometric dashed diamond around the desk pod (white = hover, animated yellow = selected,
  green + “＋ hire” on an empty desk), plus an ellipse under a selected agent who is away from the desk.
* **Overlays** (name pill, type badge, tool chip, queued pill, speech bubbles) are drawn at full resolution on top of the
  scaled canvas, anchored to projected points.
* **Flat view:** `http://localhost:3000/?view=flat` still gives the original top-down renderer (`office-flat.js`).

## Run

```bash
npm install
npm start            # http://127.0.0.1:3000  (PORT=4000 npm start to change the port)
```

`HARNESS_MODE` sets the **default agent type** preselected in the Hire dialog (and used for agents saved without one).
If unset it is auto-detected: `claude` on `PATH` → `claude`, else `cursor-agent` on `PATH` → `cursor`, else `mock`.

```bash
HARNESS_MODE=mock   npm start      # simulated agents, no CLI needed
HARNESS_MODE=claude npm start      # real Claude Code (needs `claude` installed & logged in)
HARNESS_MODE=cursor npm start      # Cursor CLI agent (needs `cursor-agent` installed & logged in)
```

All three types can be mixed in one office - pick the type per agent in the **Hire agent** dialog
(types whose CLI isn't found are flagged "CLI not found"). The type is persisted with the agent.

### Using it

| Action | How |
| --- | --- |
| Select an agent | Click the person (or their desk). Chat panel opens on the right. |
| Talk to it | Type in the box, **Enter** to send (Shift+Enter = newline). Messages sent while it's busy are queued. |
| Hire | **＋ Hire agent** (or click an empty desk): name, agent type (Claude Code / Cursor / Mock), working directory. Up to 8 desks. |
| Fire | Select an agent, **✖ Fire agent**. |
| Stop a run | **■ Stop** in the chat panel (kills the CLI process). |

Agent states and what you see:

| State | Trigger | Visuals |
| --- | --- | --- |
| idle | nothing running | subtle bob + blinking, plus random idle activities (below) |
| thinking | run started / waiting on model | thought bubble with animated dots, hand on chin |
| working | tool use or streaming text | typing arms, flickering code on the monitor, green chip with the tool name (`Bash`, `Edit`, …) |
| done | `result` event | green ✓, sparkles, arms up, smiling |
| error | CLI/run error | red `!`, worried face, red monitor, error shown in chat + bubble |

### Idle behaviour

Agents that are idle and not selected/hovered pick a random activity every ~8-22 s (weights in `pickActivity`, `public/js/app.js`):

| Activity | What you see |
| --- | --- |
| stretch | arms up, yawn |
| read | holds a little book, turns pages, looks down |
| look around | head/eyes glance left and right |
| coffee | walks to the coffee machine, sips from a mug, walks back |
| chat | two idle agents walk to the coffee machine and talk, alternating small speech-bubble icons (`...`, `!`, `?`, ♥, ♪) |

Only one coffee/chat trip at a time. Selecting an agent or giving it work (state ≠ idle) sends it back to its desk
(a chat ends for both). URL flags: `?wander=off` disables all idle behaviour, `?wander=fast` makes it happen every few seconds.
For demos/tests the console exposes `harness.forceActivity(id, 'stretch'|'read'|'look'|'coffee'|'chat', partnerId)`.

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

## Cursor mode details

Per message, with cwd = the agent's working directory (from the [Cursor CLI docs](https://cursor.com/docs/cli/reference/output-format)):

```
cursor-agent -p --output-format stream-json --trust [--stream-partial-output] [--resume <chatId>] -- "<your message>"
```

The binary is looked up as `cursor-agent`, then `agent` (newer installs), or `HARNESS_CURSOR_BIN`. Event mapping:

* `system/init` (`session_id`) → remembered, passed as `--resume` next time
* `assistant` → chat reply (one event per message segment; with `HARNESS_PARTIAL=1` only the `timestamp_ms`-without-`model_call_id` deltas are used for live streaming, duplicates skipped)
* `tool_call` `started` → **working** + tool label (`shellToolCall` → `Shell`, `readToolCall` → `Read`, `editToolCall` → `Edit`, …) and a `▸ Shell: npm test` line; `completed` → back to **thinking**
* `result` → **done** (or **error** when `is_error` / non-success); a non-zero exit without a result → **error** with stderr

`HARNESS_CURSOR_ARGS` adds extra args (`--model …`, `--force` to let it run shell commands without prompting - dangerous).

> ⚠️ **Cursor mode is untested against a real `cursor-agent`** (not installed here); it follows the documented flags and event
> shapes. It is covered by `npm run test:adapters`, which drives claude/cursor/mock agents through the real server using
> `scripts/fake-claude.js` and `scripts/fake-cursor-agent.js` (also usable as `HARNESS_CURSOR_BIN` for manual demos).

## Security notes

The server can make Claude Code run in any directory you give it. It binds to loopback by default and rejects
cross-origin WebSocket connections, but there is **no authentication** — don't expose it to a network.

## Project layout

```
server.js                 express static + WebSocket hub
lib/harness.js            agent registry, state machine, persistence, message queue
lib/adapters/claude.js    Claude Code CLI adapter (stream-json)
lib/adapters/cursor.js    Cursor CLI agent adapter (stream-json)
lib/adapters/mock.js      simulated agent
lib/adapters/index.js     adapter registry, per-type availability, default type
public/index.html, style.css
public/js/office-iso.js   isometric renderer (default): projection, furniture, 4-facing characters, depth sort, hit test, pathfinding
public/js/office-flat.js  the original top-down renderer (`?view=flat`); also supplies shared bubble/icon helpers
public/js/app.js          WebSocket client, chat panel, wandering logic
scripts/screenshots.js    Playwright demo: hires, chats, screenshots → screenshots/
scripts/fake-claude.js    fake `claude` binary for adapter testing
scripts/fake-cursor-agent.js  fake `cursor-agent` binary
scripts/test-iso.js       Playwright geometry tests: iso hit testing, paths, depth order, mouse (`npm run test:iso`)
scripts/test-adapters.js  end-to-end test of all agent types + type persistence (`npm run test:adapters`)
```

WebSocket protocol — client→server: `hire {name,cwd,agentType}`, `fire {id}`, `send {id,text}`, `interrupt {id}`;
server→client: `snapshot`, `agent` (state/tool updates), `removed`, `msg`, `msg_update` (streamed text), `error`.

## Regenerate screenshots

```bash
npm install && npx playwright install chromium
npm run screenshots     # uses the fake claude/cursor CLIs so all agent types appear
```

Shots: `01`-`09` (hiring, thinking, working + chat, error, done + reply bubble, wandering, coffee break, fire),
`10-idle-stretch-read-look`, `11`/`11b-idle-chat-at-coffee`, `12-hire-dialog-agent-type`, `13-flat-view-fallback` (`?view=flat`),
`14-hover-empty-desk`. (`07-wandering` is the walking agent.) Tests: `npm run test:iso` (needs Playwright) and `npm run test:adapters`.

## Known limitations / ideas

* Max 8 agents (desk slots); fixed office layout; the isometric camera is fixed (no rotation/zoom); bubbles of different agents can overlap.
* Claude and Cursor modes are untested with the real CLIs; no tool-permission prompts in headless mode; one process per message.
* No auth; no markdown rendering in chat; long transcripts are capped at 300 messages per agent.
* Next: agent-to-agent messaging, `/clear`/new-session button, per-agent model & permission settings,
  markdown/diff rendering, sound, day/night cycle, a meeting room for multi-agent tasks.
