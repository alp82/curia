# Live check: the rest of the codex feature table (#207)

Ticket: [alp82/curia#207](https://github.com/alp82/curia/issues/207), on the map
[Curia gets better](https://github.com/alp82/curia/issues/147). Run on 2026-08-05 on the box,
`coinmatica.net`, against codex 0.146.0 — the version `config/curia.yaml` pins — with the
operator's ChatGPT credential in place. This is the live read #172 said it owed: real dispatches,
a real account, the agent's own tool set read back from the agent.

Every run was disposable: a throwaway `CODEX_HOME` seeded from `~/.codex/auth.json`, a throwaway
git worktree, the daemon's own spawn template (`--dangerously-bypass-approvals-and-sandbox
--dangerously-bypass-hook-trust`, TUI in a tmux pane). One run repeated the probe inside the agent
image `curia-agent:2.1.220-0.146.0-fc78bbbf` with the daemon's mounts (`/cfg`, `/workspace`,
`CODEX_HOME=/cfg`, uid 1000). One probe spawned a sub-agent on purpose. Nothing else wrote.

## 1. #172's bound holds where it was aimed

`gh`-side first: `codex features list` on the operator's account still shows all seven unchosen
features `stable` and `true`, so the table #172 read from a container matches the live account.

`apps = false, plugins = false` bites, and the tool set shows it. Against curia's shipped
`[features]` table a live TUI agent lost `list_mcp_resources`, `list_mcp_resource_templates` and
`read_mcp_resource`, and a live `exec` agent lost `request_plugin_install`, relative to a
no-config baseline on the same account. The `codex_apps` namespace itself did not appear in either
lane, bound or unbound.

## 2. `multi_agent = false` is a no-op, caught live

#172 wrote `multi_agent = false` against `resume_agent` and `close_agent`, and named its own trap:
a key codex renames upstream becomes a silent no-op that reads like a bound lane. That is exactly
what happened. On 0.146 the family is `collaboration.*` and it does not sit behind the flag.

Six tools survive curia's shipped table: `collaboration.spawn_agent`, `send_message`,
`wait_agent`, `interrupt_agent`, `list_agents`, `followup_task`. Not a self-report — the probe
agent CALLED them:

- `collaboration.list_agents` returned `{"agents":[{"agent_name":"/root","agent_status":"running"}]}`
  under the shipped table, under `collaboration_modes = false` on top of it, under a table with
  every effective-true feature off except `hooks`/`shell_tool`/`unified_exec`, and inside the
  agent image with the daemon's own mounts. Four for four.
- `collaboration.spawn_agent` answered `Started /root/pong` — a real sub-agent, spawned under the
  shipped table.

No key in the `[features]` table closes this tool set. The lever #172 used does not reach it.

**The operator ruled the collaboration tools ALLOWED (2026-08-05).** They are the codex spelling
of claude's own subagents, which curia has never forbidden, and the review gate reads the output
either way. So the finding lands as a corrected comment on the `multi_agent` line, not as a bounds
line. The key stays: it is true to its name, costs nothing, and is correct again if a codex
version re-attaches the tools.

## 3. The seven are inert for a CLI agent

The headline read. With all seven off —

```toml
browser_use = false
browser_use_external = false
browser_use_full_cdp_access = false
in_app_browser = false
computer_use = false
in_app_updates = false
skill_mcp_dependency_install = false
```

— a live agent's tool set is **byte-identical** to the same run without them. Measured in the TUI
lane and the `exec` lane (schema-forced tool list, same account, same model). No browser tool and
no computer-use tool ever appears in a CLI agent's definitions, on or off. The five browser and
computer features gate the Codex desktop app and IDE surfaces, not this one.

`in_app_updates = false` also leaves `codex update` in `codex --help`, so the key does not defend
the `codex_version` pin either. The pin's real defense is unchanged: the image build installs one
pinned version, and the tag names it.

The effective state confirms the keys are read, not ignored: `codex features list` against the
same dir reports all seven `false`, and the harness-side `features=[...]` log line drops them.
So these are real switches wired to surfaces curia does not spawn.

## 4. What shipped

The operator ruled all seven OFF (2026-08-05): no capability removed today, and each is `stable`
and default-TRUE, so the next codex bump that attaches one of them to the CLI meets a stated
choice instead of a default nobody made. Seven more lines in the `[features]` table
`connectionSettings` writes, and seven more whole-line assertions in the unit test beside #172's
three. The spawn-prompt bounds are unchanged: the closed-tool-set line already covers installs,
and the collaboration tools are allowed by ruling.

The residual is the same one this file just cashed for #172: a version bump can move any of these
keys. The guard stays two-sided — the unit test pins what the harness writes, and the next live
read pins what codex does with it.
