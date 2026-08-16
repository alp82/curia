# Codex-lane gap inventory

**Question** ([#152](https://github.com/alp82/curia/issues/152)): where does the codex lane trail the claude lane?

**Method**: a read of every backend branch in `daemon/src/`, plus the two real codex worker
transcripts kept on this box. The transcripts are the stronger evidence, so this note quotes
what they say. They are `~/curia-work/cfg/curia-70/sessions/2026/07/28/rollout-*.jsonl`
(codex 0.145, gpt lane, `alp82/alperortac.com#70`) and the claude-lane counterpart at
`~/curia-work/cfg/curia-85/projects/*/f9abdd29-*.jsonl`. Both are outside the repo and a
sweep can remove them, so every claim below carries its own excerpt.

Each gap states its evidence class:

- **measured** — a transcript or the code proves it now.
- **suspected** — the code shows the asymmetry, and no live run has tested it. A fix ticket
  starts with the check.

## The list

| # | Gap | Where it lives | Evidence |
|---|---|---|---|
| 1 | A codex worker sees the operator's whole host skill set, not the installed nine | `workspace.mjs:509` `installSkills` | measured |
| 2 | Codex plants six skills of its own under `<cfgDir>/skills/.system/`, one of which installs more | `workspace.mjs:509` | measured |
| 3 | Codex offers a `codex_apps` MCP namespace curia never configured, with plugin install and uninstall | `workspace.mjs:413` codex harness | measured |
| 4 | The prompt's first line loads the wayfinder skill on claude only | `workspace.mjs:586` `writePrompt` | measured |
| 5 | The planted-config refusal never re-runs on a cross-backend fallback | `dispatch.mjs:486`, `dispatch.mjs:762` | measured (code) |
| 6 | Codex cooling waits a blind hour while the real reset sits in its own transcript | `routing.mjs:157`, `dispatch.mjs:738`, `usage.mjs:194` | measured (code) |
| 7 | The timeline dialog guard keys on claude chrome only | `timeline.mjs:103` `DIALOG_MARKERS` | suspected |
| 8 | An inbound image may not reach a codex worker at all | `images.mjs:117` `inboundContent` | suspected |
| 9 | The timeline drops an image from a codex transcript | `transcript.mjs:246` `codexItems` | measured (code) |
| 10 | Another device's queued input renders on the claude lane only | `transcript.mjs:184` | suspected |
| 11 | Resume never inherits the backend the dead worker ran | `commands.mjs:59`, `bridge.mjs:88` | measured (code) |
| 12 | `backend=` on `start` is never checked against the model's own backend | `commands.mjs:128` | measured (code) |
| 13 | Four test files carry no codex case | `daemon/test/` | measured |

## The detail

### 1. The skill set is not bounded on the codex lane

`installSkills` links the nine `DEFAULT_SKILLS` into `<cfgDir>/skills`, and the list omits
`to-tickets`, `triage`, `to-spec` and `handoff` on purpose (`workspace.mjs:478`). The
curia-70 worker was listed 25 skills, read straight off the host root:

```
(file: /home/alp/.agents/skills/to-tickets/SKILL.md)
(file: /home/alp/.agents/skills/triage/SKILL.md)
(file: /home/alp/.agents/skills/to-spec/SKILL.md)
(file: /home/alp/.agents/skills/handoff/SKILL.md)
```

All four excluded skills are there, and so are `computer-use`, `orca-cli` and
`orchestration`. The exclusion was already in force: it landed with
[#57](https://github.com/alp82/curia/issues/57) (`c20bf09`), before this run.

The worker's own `<cfgDir>/skills` still holds exactly nine symlinks, so codex reads a
second root. Which root is not yet pinned. That is the first step of the fix.

No counterexample exists on the claude lane. Its transcript never names an excluded skill.
Claude Code states its skill list in the system prompt, which the transcript does not store,
so this is an absence of evidence rather than proof of a bound.

### 2. Codex adds six skills of its own

`<cfgDir>/skills/.system/` holds `imagegen`, `openai-docs`, `plugin-creator`,
`review-agent`, `skill-creator` and `skill-installer`. `installSkills` deletes the whole
`skills` directory on every seed, so codex writes them back on every spawn.
`skill-installer` installs further skills. The claude lane has no equivalent.

### 3. A second MCP namespace the daemon did not write

curia's `config.toml` states one server, `[mcp_servers.curia]`. The codex worker also
carried `mcp__codex_apps__plugin_management`, plus `resume_agent`, `close_agent` and
`_update_app_permissions` in its tool set:

```
Plugin Management: uninstall: uninstall_app; suggest install/connect:
plugin_management.search_plugins then plugin_management.suggest_plugins.
```

The worker called none of them. The bounds in the spawn prompt name none of them either.
This matters most for the container work at
[#148](https://github.com/alp82/curia/issues/148): a lane that can install apps is a wider
surface than the one the sandbox decision costed.

### 4. The first line of the prompt is a claude mechanism

`writePrompt` puts `/wayfinder <map url> ticket #<n>` on line 1, and the comment above it
calls that the only working form. It is, on claude. The curia-85 transcript shows the
expansion:

```
<command-name>/wayfinder</command-name>
<command-args>https://github.com/alp82/curia/issues/76 ticket #85 …
```

On codex the same line arrives as plain text inside an ordinary user message:

```
"text":"/wayfinder https://github.com/alp82/alperortac.com/issues/66 ticket #70\n\n# …
```

Nothing expanded it. That worker did reach the skill, but by its own initiative, with
`sed -n '1,240p' /home/alp/.agents/skills/wayfinder/SKILL.md`. The harness never loaded it.
`disable-model-invocation: true` is claude frontmatter, and it does not stop a codex worker
from reading the file.

So the codex lane runs wayfinder tickets on a model that must find its own procedure. One
run found it. Nothing makes the next one find it.

### 5. The planted-config refusal has a hole on the fallback path

`#assertNoPlantedConfig` runs once, at dispatch, against the dispatch backend
(`dispatch.mjs:486`). Each lane loads one repo-carried config file with no prompt:
`.codex/hooks.json` for codex, `.claude/settings.local.json` for claude
(`workspace.mjs:466`).

`#handleLimit` respawns down the fallback chain, re-seeds the config dir and rewrites the
harness for the new backend (`dispatch.mjs:762`). It does not re-run the refusal. So a repo
carrying `.codex/hooks.json` passes the claude check, and a cooling fallback to `gpt` then
spawns codex with `--dangerously-bypass-hook-trust` in that worktree. A planted project hook
fires under that flag. `workspace.mjs:457` records that as verified.

The refusal message already offers "dispatch on another backend if only one lane loads it".
The fallback does exactly that, in reverse, with no human in the loop.

### 6. Codex cools blind while its own transcript states the reset

`LIMIT_PATTERNS.openai.reset` is `null` (`routing.mjs:157`), so `#handleLimit` applies the
conservative one-hour cooldown and journals `reset_unparseable` (`dispatch.mjs:738`). The
claude lane cools until the stated reset.

The instant exists. `codexTail` already reads `rate_limits.<slot>.resets_at` off the
`token_count` event for the status-line bars (`usage.mjs:194`). The cooling path and the
meter path never meet.

### 7. The dialog guard was measured on claude panes only

`DIALOG_MARKERS` keys on `Enter to <verb> ·` and `↑/↓ to navigate` (`timeline.mjs:103`).
Every fixture in `timeline.test.mjs:20-40` is a claude pane, and the veto regex is the claude
composer marker. No codex dialog footer was ever captured.

The codex spawn passes `--dangerously-bypass-approvals-and-sandbox`, so its approval and
trust prompts do not appear. Its other dialogs stay reachable, the `/model` picker among
them, and a timeline `/send` into one is the exact loss
[#75](https://github.com/alp82/curia/issues/75) exists to stop. The fix starts with one
capture of a codex dialog footer.

### 8. Inbound images may stop at the codex lane

`inboundContent` returns MCP `image` content blocks (`images.mjs:117`). That landed with
[#34](https://github.com/alp82/curia/issues/34), before the codex lane existed
([#39](https://github.com/alp82/curia/issues/39)). Whether codex renders an `image` block
from an MCP tool result is untested. If it does not, a human who answers with a screenshot
gets a silent drop on this lane.

### 9. The timeline shows nothing for an image on the codex lane

`codexItems` keeps `output_text` and `input_text` and drops the rest, so a message whose only
content is an image renders as no item at all (`transcript.mjs:246`). The claude lane shows
`[image]` (`transcript.mjs:175`). This is the timeline's half of gap 8, and it is true in the
code today whatever the answer to gap 8 turns out to be.

### 10. Queued input is a claude-lane item

`claudeItems` renders `queue-operation`/`enqueue`, so the timeline shows the moment another
device's mid-turn input became visible (`transcript.mjs:184`). `codexItems` has no
counterpart. Whether codex writes such an event at all is unknown, so this may be a
non-issue. One codex transcript with a mid-turn send settles it.

### 11. Resume drops the lane

`Dispatcher.resume` forwards `model` and `backend` (`dispatch.mjs:1604`), but no surface
supplies them. The parser accepts `resume <n>` or `resume all` and nothing else
(`commands.mjs:59`), and the slash command declares no options (`bridge.mjs:88`). So a
resumed ticket re-routes from its labels. A `wayfinder:task` ticket that ran on gpt comes
back on opus. The worktree is inherited. The lane is not.

### 12. `backend=` can contradict the model

`start <n> model=x backend=y` validates only that `y` is a configured backend
(`commands.mjs:128`). Nothing checks it against `models.<x>.backend`. So
`start 5 model=opus backend=codex` builds `codex --model opus`, which is not a model. The
spawn dies at the composer, and since [#169](https://github.com/alp82/curia/issues/169) the
pane says why. A refusal at parse time is cheaper.

### 13. Test coverage

`dispatch`, `routing`, `timeline`, `usage`, `workspace` and `config` all carry codex cases in
rough balance with claude ones. Four files carry none: `prompt.test.mjs` (the prompt is
backend-blind, which is gap 4), `statusline.test.mjs`, `keepalive.test.mjs` and
`index.test.mjs`.

## Measured parity, so do not re-open it

- The **review gate** works on codex. The curia-70 worker blocked 400 seconds on
  `request_review` and got the approval back:
  `"Wall time: 399.9884 seconds … APPROVED by the human."`
- **ask_human** blocks and returns on codex, including the `choice` kind.
- The **Stop hook** is Claude-compatible on codex, `stop_hook_active` included
  (`workspace.mjs:228`), and `/worker_done` answers the empty object codex's closed schema
  needs (`index.mjs:923`).
- **Credentials** are shared, not copied, on both lanes, by opposite mechanisms
  (`workspace.mjs:376`).
- The **ready marker**, the **exit marker** and the **usage-limit vocabulary** are per
  backend and read off live panes (`routing.yaml`, `routing.mjs:135`).
- **Context percent** and the **account bars** are per backend, and the codex lane is the
  cheaper of the two (`usage.mjs:168`).
- `lifecycle.mjs`, `resolve.mjs`, `github.mjs`, `attach.mjs`, `preview.mjs`, `health.mjs`,
  `messaging.mjs`, `reduction.mjs` and `identity.mjs` name neither backend. They act through
  `gh`, Discord and the daemon, so they carry no lane at all.

## What graduates from here

Gaps 1, 2, 3 and 5 are containment, and they belong beside the sandbox work at
[#148](https://github.com/alp82/curia/issues/148). Gap 4 decides whether a codex worker can
be trusted with a map ticket. Gap 6 is a small, self-contained fix with its source already
parsed. Gaps 7 to 10 are the attach surfaces, and each starts with one capture from a live
codex worker. Gaps 11 and 12 are command-surface repairs.
