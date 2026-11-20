# Multiple agents, one chat UI

Goal: the same chat UI (mod `chat`) for **Pi, Claude Code and Codex**, then
others. The rule: nothing provider-specific is hard-coded outside an adapter
(`host/providers/<agent>/`); the core and the mod read capabilities and the
adapter's answers. The ids and names are listed once on each side:
`host/providers/index.ts` (the host) and `herdr-app/mods/chat/util.js` (the mod; a mod
can't import the host's code).

## The seam

```
mod (provider-neutral: renders Items + ChatState, sends ops; adapts to `capabilities`)
   │  protocol.md: unchanged wire, plus `state.provider` and `state.capabilities`
host core (provider-neutral)
   server.ts · registry.ts · terminal.ts (OSC 7501, hc send, transcript) · coalescing · timeline store
   blocks/highlight/mermaid/ansi · images · files · clipboard · sessions lock · built-in slash commands
   │  ProviderAdapter interface (host/providers/types.ts)
   ├── host/providers/pi/       pi --mode rpc           (today's pi-rpc.ts + the Pi half of chat.ts/timeline.ts)
   ├── host/providers/claude/   Claude Code, structured mode (see research)
   └── host/providers/codex/    Codex app-server JSON-RPC (see research)
```

An **adapter** owns:
- spawning and talking to its agent process;
- turning that agent's events into a small set of **normalized events**;
- carrying out normalized commands.

The core owns everything a user sees, so every provider renders the same way.

### Normalized events (adapter → core), first draft

These are refined after the Claude and Codex research.

- **run:** `run_started {autonomous?, cause?}`, `run_settled {aborted, error?}`, `queue_changed {steering[], followUp[]}`
- **message:**
  - `user_message {text, images, source, from?}`;
  - `assistant_delta {msg, index, kind: "text"|"thinking", delta}`;
  - `assistant_block_end {msg, index, kind, text}`;
  - `assistant_end {msg, stopReason, error?, model?, usage?, durationMs?}`.
- **tool:**
  - `tool_started {callId, name, args}`, `tool_progress {callId, partialOutput}`;
  - `tool_ended {callId, ok, output, images?, exitCode?, diff?}`;
  - `name` is mapped to a ToolDetail by a **shared** classifier (host/tools.ts). Each adapter brings its `tools` (a ToolMap, `host/providers/<agent>/tools.ts`): its names for the shared kinds (Pi `bash`/`read`/`edit`/…, Claude `Bash`/`Read`/`Edit`/`MultiEdit`/`Write`/`Grep`/`Glob`/`WebFetch`/`Task`, Codex `commandExecution`/`fileChange`/`mcpToolCall`/`webSearch`), and hooks for what only it sends (Codex's shell wrapper and parsed command actions, Claude's patch in its edit results). The shared code never names an agent.
- **ask** (one shape for extension dialogs, permission prompts and questions): `ask {id, kind: "select"|"confirm"|"input"|"editor"|"permission", title, message?, options?, tool?: {name, args}, timeoutAt?}`, answered by the `dialog_answer` op. Permission asks render as an approval card: "Allow once / Always / Deny".
- **decoration:** `status {key, text}`, `widget {key, placement, lines}`, `title {text}`, `notice {level, text}` (from the agent: extensions, hooks, system messages)
- **session:** `session {id, file?, name?}`, `model {provider, id, name, reasoning, contextWindow}`, `thinking {level}`, `usage {contextTokens, contextWindow, cost}`, `compaction {phase, …}`, `retry {…}`
- **lifecycle:** `exited {code, stderrTail}`

### Commands (core → adapter)

- `prompt {text, images, mode: auto|steer|followUp}`, `abort`, `answer {askId, value}`. The core holds follow-ups itself while a run is on (protocol v3.2), so an adapter sees `followUp` only in its own edge cases
- optional `canRemoveQueued(id)` / `removeQueued(id)`: take back a queued message the agent hasn't taken yet (Pi: clear and re-add; Claude Code: `cancel_async_message`; Codex: none)
- `listModels`, `setModel`, `setThinking`, `compact`, `newSession`, `switchSession`, `setName`
- `sessions: SessionSource`: where /resume's sessions come from. `{kind: "files", files(current, scope), describe(path)}` (Pi, Claude Code: the core reads and caches them, `host/sessions.ts`) or `{kind: "agent", list(scope)}` (Codex: `thread/list`, a page at a time). The core lists, searches (name, first message, folder) and marks each `here` the same way for every agent
- `history()`: the normalized events to rebuild a resumed session
- `tuiCommand(session)`: the argv of the agent's own TUI on this session, for hand-offs. Examples: `pi --session <f>`, `claude --resume <id>`, `codex resume <id>`.
- optional `forkPoints()` and `fork(point)`: the person's messages, and a new session holding what came before one of them (resolves with the message's text). Pi: `get_fork_messages` / `fork`. Claude Code: its transcript's prompts, then a restart with `--resume <id> --fork-session --resume-session-at <the answer before>` (the fork's transcript is written at its first prompt; until then the history is the original's up to that answer). Codex: the turns' first `userMessage`, then `thread/fork {lastTurnId: the turn before}` on the same model and effort.
- optional `tuiInput(name)`: what the chat types into the agent's terminal for a built-in that opens one, so it lands on that screen (Pi `/login`, Claude Code `/config`).

### Capabilities (in `ChatState.capabilities`, the mod adapts)

| capability | Pi | Claude Code | Codex | Generic ACP |
|---|---|---|---|---|
| `steer`, `followUp` | yes | yes | yes | no, yes (adapter queue) |
| `thinkingLevels` | off…xhigh | the model's efforts | the model's efforts | none |
| `permissions` + `permissionModes` | no (Pi has no approvals) | yes: Ask, Accept edits, Plan, Auto | yes: Ask first, Read only, Auto, Auto-review, Full access, Plan | yes, no modes |
| `extensionUi` (statuses, widgets) | yes | no | no | no |
| `compact` / `compactInstructions` | yes / yes | yes / yes | yes / no | no / no |
| `rename`, `fork` | yes | yes | yes | no |
| `images` | per model | yes | per model | agent capability |
| `cost` | yes | yes | no (tokens only) | no |
| `tui` | yes | yes | yes | optional, per spec |

What else differs, from each agent's own mechanism, not from the chat:

| | Pi | Claude Code | Codex |
|---|---|---|---|
| Terminal utilities (`utilityCommand`) | login, settings, scoped-models | login, settings (`/config`) | login |
| TUI commands (`tuiCommands`) | its built-ins RPC doesn't run (tree, export, share, session…) | its terminal-only commands (doctor, theme…) | its TUI's (init, status, review, diff, mcp…) |
| Another process on the session | the lock extension | its `~/.claude/sessions` registry (`sessionHolder`) | its "active writer" error |
| The chat follows a session switch made in `/tui` | yes (the lock extension's hand-off file) | no | no |
| Continue as chat: the TUI's session (`tui.ts`) | the lock extension's label | its `~/.claude/sessions/<pid>.json` | the rollout it has open, else the newest in its folder |
| The plan (`state.plan`; a subagent's is a `plan` card) | none | TodoWrite: the chat's plan from the call, a subagent's as its card. TaskCreate/TaskUpdate/TaskList: the chat's plan, subagents' changes included, from the results (`plans.ts`), in task id order; a resume carries the transcript's list on, a fork starts a new one | `turn/plan/updated`, each turn's update replaces the plan; a subagent thread's is its card. Resume reads the rollout's `update_plan` calls (`rollout.ts`; code mode's `exec` JS too), and a fork's source's up to the fork |

## Process (one host process per chat)

- **Launcher:** ⌘I opens `new-chat`, which offers each agent install found.
- The provider is a chat prop: `{chat, cwd, provider}`. The host gets it as `serve --provider pi|claude|codex|gjc`.
- The registry records it, so reopening uses the same provider.
- The Herdr agent status (OSC 7501) reports `app=pi|claude|codex|gjc`, so Herdr shows the right icon.

## Adding an agent

1. `host/providers/<id>/`: the adapter (`ProviderAdapter`), its `tools.ts` (ToolMap), a fake agent under `tests/fake-<id>/`, host tests.
2. Register it in `host/providers/index.ts`, and its name and icon in `herdr-app/mods/chat/util.js` (`PROVIDER_NAMES`, `icons/providers/<id>.svg`).
3. The launcher's entry (`herdr-app/mods/new-chat/main.js` `CHOICES`), its key name (`install/keys.ts`), its instruction file (`install/instructions.ts`) and `PROVIDERS` in `install/app.sh`.

### Adding an ACP agent

Use `createAcpAgent(spec, opts)` from `host/providers/acp/spec.ts` for an
agent that implements the Agent Client Protocol over standard I/O. The spec
provides its id, display name, executable, arguments and environment. Optional
`clientMeta` supplies initialization metadata and `tui` provides the argv for
hand-off; `{session}` in a TUI argument is replaced by the session reference.
Register the resulting adapter as described below; agent settings are
not a registry. The default adapter stores session pointers in the host state
directory and resumes them through `session/load`.

The generic ACP adapter queues messages while a turn is running, supports
permission requests and reports streamed text, thinking, tools and plans.
Session settings come from the `configOptions` of `session/new`,
`session/load`, `session/set_config_option` and `config_option_update`: the
select option of category `model` is the model list and the model, category
`thought_level` the thinking levels and level. The session's modes (or a
`mode` option when it has none) are the permission modes; changes go out as
`session/set_config_option` and `session/set_mode`, and a refused change
reports the setting the agent still has, with a notice. `available_commands_update`
is the command list, `usage_update` the context usage. /resume lists the first
page of `session/list` (with `cwd` for this folder): `modified` is
`Date.parse(updatedAt)` (0, last, when missing or invalid), newest first, no
message count. `switchSession` and `newSession` cancel and wait for the running
prompt (at most 5 s; a later answer is dropped), settle the run, drop the queue and asks, then `session/load` or
`session/new`; the session left is closed with `session/close` when the agent
offers it (loading it again waits for that close), and updates and permission
requests of another session are ignored. There is no fork,
compaction, renaming or TUI unless a subclass or a TUI command adds them.
Agents with additional lifecycle semantics
can subclass `AcpAdapter` and override its protected hooks: `sessionRef` and
`sessionIdOf` (session pointers), `sessionPaths` (the references of listed
sessions), `commandSource` (a command's menu group), `sessionChanging`,
`clientMeta`, `phaseHint` and `onPhaseHint`,
`onPromptOutcome` (retry or handle a prompt), `settleGate` (hold the run open),
`steer` (send a text message into the turn of an unanswered prompt: accepted,
rejected, or unsupported, which turns steering off for the session) and
`onRunSettled`/`onConnectionClosed`. `tests/fake-acp/` is a scripted ACP agent for
an ACP agent's host tests.

## GJC (ACP)

The GJC provider runs `gjc --mode acp` and requires GJC 0.21.0 or newer. It
discovers GJC's own session files and waits for idle phase hints after a prompt
before releasing queued messages. Background runs remain working until an idle
hint arrives; the agent does not let the chat stop such runs. A busy conflict is
retried at most three times, then unsent text returns to the composer. Enter
while GJC works on the chat's own prompt steers with `_gjc/sdk/control`
`turn.steer`; GJC does not echo a steer, so the adapter adds the message to the
timeline when GJC accepts it. GJC also accepts a steer as the turn ends, as a
follow-up it would run as a turn of its own whose output this client never
receives; the adapter finds such a steer in `queue.messages.list`, removes it
with `queue.message.remove` and keeps it in its own queue. The check runs once,
right after the answer: a steer GJC moves to its follow-up queue later, at the
turn's very end, still runs unseen. After GJC answers the prompt (the run's
tail) or during a run GJC started itself, Enter queues without steering. Esc
waits up to 2 s for a steer on its way, so one GJC took stays in the timeline
and one it refused returns to the composer; if GJC takes it later, a notice says
so. A refused steer waits in the adapter queue (or starts the next run if the
turn has already ended). A message with images and ⌥Enter follow-ups also wait
for the run's end. A GJC without `_gjc/sdk/control` or `turn.steer` turns
steering off for the session.

The model chip lists GJC's model presets and the thinking chip its levels
(its `configOptions`); the mode chip shows Default and Plan, but GJC 0.21 refuses
Plan over ACP (no plan-mode lifecycle there), so choosing it leaves Default with
a notice. GJC's skills (`skill:<name>` commands) are in the `/` menu as skills.
/resume lists GJC's sessions by their session files. `/compact` runs
`compaction.run` (no instructions); GJC's own compaction, reported in
`session_info_update._meta.gjcCompactionState`, shows as compaction notices.
`/name` runs `session.rename`. The footer's cost is `usage.get`'s; without it
the footer shows no cost. A GJC without `_gjc/sdk/control` turns compaction and
renaming off with a notice. TUI hand-off is not yet available.

| GJC capability | Support |
|---|---|
| steer / follow-up | `turn.steer` (text only) / adapter queue |
| permissions | agent approval choices |
| model presets, thinking, modes | `configOptions`, `session/set_config_option`, `session/set_mode` (Plan refused by GJC 0.21) |
| commands | `available_commands_update` (skills as `skill:<name>`) |
| sessions | `session/list`, `session/load`, `session/new`, `session/close`; no fork |
| compaction, rename, cost | `compaction.run`, `session.rename`, `usage.get` |
| TUI hand-off | unavailable |
