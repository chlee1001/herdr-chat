# GJC chat: handoff notes (2026-11-23)

What the fork's GJC chat does, what is known to be shaky, and how to pick the work up on another machine. Everything here was observed on 2026-11-23 unless it says "inferred" or "not checked".

## Where things stand

- The fork is `chlee1001/herdr-chat` (upstream `ChmaraX/herdr-chat`). Its `main` carries the GJC provider (F0 to F5), release v0.5.0, and upstream 0.6.0 merged with a merge commit (kept so the next sync doesn't conflict again).
- herdr-gajae (`chlee1001/herdr-gajae`) installs the fork next to herdr-nvim (its PRs #16 and #17). **Decision: the chat is to be left out of herdr-gajae's default install.** That code is still on herdr-gajae's `main`; leaving it out is a revert (or an opt-in flag) there, not done yet.
- The last three changes (below) are one PR from `feat/gjc-permission-modes`. See the PR list of the fork for whether it merged.

## Using the GJC chat

| To do | How |
|---|---|
| Open a GJC chat | the new-chat overlay, or the `gjc` launcher key |
| Change the permission mode | the chat's mode picker: `Default` (a card before each tool call) or `Auto-approve` (tools run without asking: reads, writes, shell) |
| Chat to terminal | type `/tui` in the composer or press cmd-alt-t. `gjc --resume <session>` opens in a terminal; **Quit it** in its dialog returns to the chat |
| Terminal to chat | in an ordinary terminal tab running `gjc`, once its reply has ended: right-click, **Continue as chat** |

- The mode is `Default` at the start and after a session change. `Plan` is not offered: GJC refuses it over ACP.
- Continue as chat is for a `gjc` you started in a normal tab. The terminal that `/tui` opens has no pane, so leave that one with **Quit it**.

## The three changes of the last PR

1. **Permission modes** (`docs/dev/providers.md`, `host/providers/acp/adapter.ts`, `host/providers/gjc/adapter.ts`, `tests/fake-acp/gjc-mode.mjs`, `tests/host/acp-settings.test.ts`). The adapter sent `permissionHandling: "prompt"`, so GJC asked even for `git status`. GJC reads that value at initialize time; at run time the SDK control `_gjc/sdk/control` with `{sessionId, operation: "permission_mode.set", input: {mode: "allow" | "prompt"}}` switches it. The override seam in the ACP adapter is generic; the GJC specifics stay in the GJC adapter. Nothing under `host/providers/acp/` may mention gjc.
2. **Hand-off PATH** (`herdr-app/mods/chat/main.js`, `startHandoff`). `hc run` starts the terminal with a PATH that lacks `~/.bun/bin`; `gjc` is `#!/usr/bin/env bun`, so the terminal exited 127 at once and the chat resumed as if the TUI had been quit. The command now starts with `env PATH=<recorded path>`.
3. **TUI under a PTY proxy** (`host/providers/tui.ts`, `tests/host/tui-process.test.ts`). With a wrapper that owns the outer terminal (ghost-complete, `script`), the agent runs in the shell's foreground group, not the top process's. An agent whose `pgid` equals its own `tpgid` is now accepted. The new test fails without the change and passes with it.

Gates run on the committed state: see the PR body. The hand-off PATH change has no automated test (it is mod code that only runs inside the app).

## Known problems, not fixed

- **Fast chat/terminal round trips can fail to load the session**: the host log shows `ACP load failed: ... has no current Router attachment`, and the chat then starts a new session, so the earlier conversation looks lost (2 cases seen; host logs are under `data/herdr-chat/logs/` in the app home).
  - At the same time the GJC broker was logging `Lifecycle ledger append exceeds configured bounds` (1729 times that day). Whether that causes the failure is **inferred, not shown**.
  - It did not reproduce with the probes in `research/gjc-handoff-probes/` (`load.mjs` loads one session; `cyc.mjs` loops chat, TUI, chat). Loading one session from three ACP processes at once fails differently (`Live foreign provider holds: permission`).
  - A possible change, not made: retry the load once, and put the real reason in the warning (`host/providers/acp/adapter.ts`, shared with the other agents).
- Not checked: Continue as chat end to end in the app after change 3; the cmd-alt-t round trip; whether the chat's mode and effort chords clash with other keys (herdr-gajae's board uses cmd-shift-a); `LIVE=1` tests.
- The chat's value for GJC depends on the round trip being steady. Treat it as an escape hatch, not a daily flow (an opinion, not a measurement).

## Picking it up on a new machine

1. Clone the fork and add the remote: `git remote add upstream https://github.com/ChmaraX/herdr-chat`.
2. Node 24 or later for a checkout (`export PATH=<node 24>/bin:$PATH`); `HERDR_CHAT_TEST_NODE=<node 20>` for `npm run test:built`.
3. Gates: `npm ci`, `npx tsc --noEmit`, `npm test`, and `grep -ri gjc host/providers/acp` must print nothing.
4. Install into an app home: `./install.sh --no-layout --no-subagents` (back the app home up first). Roll back with `./install.sh --uninstall`.
5. GJC 0.21.0 or later is required; this was tested on 0.22.0. `gjc` must be on the PATH the installer records (`mods/chat/config.json`, key `path`).
6. Keep out of upstream's files so the next sync stays easy: `host/chat.ts`, `host/timeline.ts`, `host/sessions.ts`, `host/commands.ts`, `host/providers/types.ts`, `docs/dev/protocol.md`, and the pi, claude and codex adapters.
7. Commit style: English Conventional Commits, no agent signature. PR to the fork's `main`; merge upstream syncs with a merge commit, never a squash.
8. The central llm-wiki holds the session record and the accepted notes (project `herdr-chat`); connect a workspace with `llm-wiki init --path <dir> --wiki <clone> --project herdr-chat --category personal`.
