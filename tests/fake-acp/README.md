# Fake ACP agent

`fake-acp.mjs` is a scripted ACP stdio agent. `FAKE_ACP_SCENARIO` names a JSON
file with an `actions` array; actions include `text`, `thinking`, `permission`,
`wait_cancel`, `exit`, and raw ACP updates in an `update` property. An action
may include `delay` in milliseconds. Set `conflict` to make prompt requests
fail with a conflict error. `FAKE_ACP_STORE` persists sessions across process
restarts and `FAKE_ACP_LOG` records requests and permission responses as JSONL.
Extension methods are logged and answered by the mode's `extMethod`, or with
-32601 when it has none.
Session settings: `configOptions` and `modes` are what `session/new` and
`session/load` answer with (a new session starts from them again);
`session/set_config_option` and `session/set_mode` change them and send
`config_option_update` / `current_mode_update` (`quietConfig` sends only the
answer), and `refuse` lists config and mode ids whose change fails (`setDelay`: ms before a change is answered). `commands`
is sent as `available_commands_update` after a session opens (after
`commandsDelay` ms). `session/list` answers `sessions` as given, or the
sessions this agent opened (by `cwd`); `session/close` is logged. `stray` makes
the session left behind by `session/new` send output afterwards.
The GJC mode (`gjc-mode.mjs`) answers `compaction.run` (`compactDelay`,
`compaction: "failed"`), `session.rename`, and `usage.get` with FINDINGS fact
14's values (`usage: "unknown_operation"` refuses it); `sdk: "method_not_found"`
makes it a GJC without SDK methods, and `deaf` makes `session/cancel` not stop
a turn.
`FAKE_ACP_MODE` names an optional module whose `createMode({scenario, update,
permission})` flavours the agent like a specific one (its `agentInfo`, phase
metadata, session files); without it the agent is plain ACP.

`host.ts` starts the real host through a test-only entry point which installs
`fake-acp` into its in-memory provider registry; production providers are not
modified. `acp-generic` and `acp-turns` also exercise the adapter directly.
