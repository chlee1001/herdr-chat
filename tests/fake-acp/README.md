# Fake ACP agent

`fake-acp.mjs` is a scripted ACP stdio agent. `FAKE_ACP_SCENARIO` names a JSON
file with an `actions` array; actions include `text`, `thinking`, `permission`,
`wait_cancel`, `exit`, and raw ACP updates in an `update` property. An action
may include `delay` in milliseconds. Set `conflict` to make prompt requests
fail with a conflict error. `FAKE_ACP_STORE` persists sessions across process
restarts and `FAKE_ACP_LOG` records requests and permission responses as JSONL.
`FAKE_ACP_MODE` names an optional module whose `createMode({scenario, update})`
flavours the agent like a specific one (its `agentInfo`, phase metadata,
session files); without it the agent is plain ACP.

`host.ts` starts the real host through a test-only entry point which installs
`fake-acp` into its in-memory provider registry; production providers are not
modified. `acp-generic` and `acp-turns` also exercise the adapter directly.
