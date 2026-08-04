# Live check: bounding a codex agent's tool set (#172)

Ticket: [alp82/curia#172](https://github.com/alp82/curia/issues/172), on the map
[Curia gets better](https://github.com/alp82/curia/issues/147). Run on 2026-08-04 inside a live
containerized agent, against codex 0.146.0 — the version `config/curia.yaml` pins. Every check
reads. Nothing on any account was written.

The fault is gap 3 of
[docs/research/codex-lane-gaps.md](../research/codex-lane-gaps.md) (#152). curia writes one MCP
server into `config.toml`, `[mcp_servers.curia]`. A live codex agent also carried
`mcp__codex_apps__plugin_management` — search, install and uninstall apps — plus `resume_agent`,
`close_agent` and `_update_app_permissions`. The bounds named none of them.

This is the codex half of [#180](https://github.com/alp82/curia/issues/180), which shut the same
fault on claude. The two mechanisms rhyme: the namespace follows the CREDENTIAL, not the config
file, and [ADR-0007](../adr/0007-shared-credential-store.md) shares that credential with the host
on purpose.

## 1. The lever is a table curia already writes

Codex carries a feature registry, and `codex features list` prints the effective state of every
entry. Three of them hold the tools gap 3 measured. All three are `stable`, and all three default
to **true**:

```
$ codex features list
apps                                 stable             true
plugins                              stable             true
multi_agent                          stable             true
```

`apps` and `plugins` are the `codex_apps` namespace itself. `multi_agent` is the other half of
the measured tool set: the binary carries `core/src/tools/handlers/multi_agents/resume_agent.rs`,
and `close_agent` sits beside it in the same handler set.

Nothing had to be invented to turn them off. `connectionSettings` already writes a `[features]`
table into `config.toml` for `hooks = true`. The bound is three more lines in that table.

## 2. The trap is the opposite shape to #180's, measured both ways

#180 found that an invalid claude allowlist enforces an EMPTY one, which takes curia's own server
down with it. Codex fails the other way, and both halves were induced:

| `config.toml` under `[features]` | result |
|---|---|
| `not_a_real_feature = false` | **ignored in silence**, exit 0, `hooks` still true |
| `apps = "false"` | **hard error**, `invalid type: string "false", expected a boolean` |

So no value here can quietly take curia's own MCP server down — a wrong type stops the spawn at
startup, loudly, where the pane says why (#169). The live risk is the other row. A key codex
renames upstream becomes a no-op that reads exactly like a bound lane, and it buys the whole
surface back with nothing to say so.

That is why the guard is two-sided. A unit test pins the string the harness writes. This check
pins codex's own read of the effective state.

## 3. The end-to-end read, against the shipped code

Not a hand-written file. `seedConfigDir` and `writeConnectionSettings` were called to produce a
real config dir, and codex was pointed at it:

```
$ CODEX_HOME=<the dir the daemon just wrote> codex features list
apps                                 stable             false
hooks                                stable             true
multi_agent                          stable             false
plugins                              stable             false
```

curia's own server still stands in the same dir, which is the failure #180 warned about:

```
$ CODEX_HOME=<same dir> codex mcp list
Name   Url                                                    Status   Auth
curia  http://127.0.0.1:4271/mcp?agent=curia-172x&ticket=172  enabled  Unsupported
```

## 4. What `codex debug prompt-input` can and cannot prove

`codex debug prompt-input` renders the model-visible prompt as JSON, and it needs no credential.
It looked like the instrument for this ticket. It is not, and the reason is worth recording so the
next session does not reach for it.

Its output does not change for ANY feature flag. Twelve were disabled one at a time — `apps`,
`plugins`, `multi_agent`, and nine others including `hooks` and `personality`, which certainly
gate behavior — and the rendered text was byte-identical every time:

```
baseline               62e36914c4141cd3bbd69586d5881bd3
--disable hooks        62e36914c4141cd3bbd69586d5881bd3
--disable multi_agent  62e36914c4141cd3bbd69586d5881bd3
… nine more, all the same hash
```

(Compare the TEXT, not the JSON. Every message carries a fresh `id`, so the raw output differs on
every run whatever the flags say.)

The debug surface does not apply feature gating to prompt assembly. So its multi-agent developer
message survives `multi_agent = false`, and that says nothing either way about the tool set.

## 5. What is NOT proved here, and what would prove it

**The `codex_apps` tools were not watched disappearing.** The namespace needs ChatGPT backend auth
— the binary answers `ChatGPT connectors require Codex backend auth` — and this container holds no
codex credential. On a clean `CODEX_HOME` the namespace is absent whatever the flags say, so there
is no before state to measure against.

What is proved is codex's own statement of effective state, from the dir the daemon writes. What
is not proved is the tool list a real agent receives from the account behind
`~/.codex/auth.json`.

That needs one codex dispatch on the box, with the operator's credential in place, and a read of
the agent's own tool set. It is the same shape as #180's own residual: that check found the
container lane already closed by accident, and could not re-measure the bare-pane lane from inside
a container either.

## 6. What shipped

Three lines in the `[features]` table `connectionSettings` already writes:

```toml
[features]
hooks = true
apps = false
plugins = false
multi_agent = false
```

Plus one bounds line in the spawn prompt, which is the half no setting reaches. A harness keeps
ordinary ways to widen its own reach that no config key covers: a skill that installs an MCP
server, `codex plugin add`, `claude mcp add`, a marketplace. The line is written harness-blind,
because it is true on both lanes and the prompt is one text.

The operator ruled the width on 2026-08-04: these three, not `apps` and `plugins` alone.

Six more features on the same list are default-on, unchosen, and out of scope here:
`browser_use`, `browser_use_full_cdp_access`, `computer_use`, `in_app_browser`, `in_app_updates`
and `skill_mcp_dependency_install`. The first four are a browser that looks at a page, against the
standing bound that a browser is a build tool and never a judge. `in_app_updates` can move the CLI
off the `codex_version` pin. `skill_mcp_dependency_install` reopens the very namespace this ticket
closes. They carry their own ticket.
