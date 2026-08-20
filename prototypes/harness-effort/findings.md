# How each harness takes a reasoning effort (#559)

PROTOTYPE — throwaway evidence for [alp82/curia#559](https://github.com/alp82/curia/issues/559).
The build handoff (#533) reads this note as ground truth.

Every claim below comes off a real run in this container. Each harness ran in a detached
tmux pane through `drive.mjs`, which imports the daemon's own paced write path from
`daemon/src/tmux.mjs`. Each harness talked to a local stand-in model server that logs every
request whole. The effort a spawn states is read off the request body, never off a pane
rendering. Raw wire captures sit in `evidence/`, and `req-N` below names those files.

The daemon's union in `daemon/src/config.mjs`: `low | medium | high | xhigh | max | ultra`.

## claude 2.1.220 (wire: `POST /v1/messages`, field `output_config.effort`)

- **Mechanism.** The spawn flag `--effort <level>`. Also the env var
  `CLAUDE_CODE_EFFORT_LEVEL` (`claude-wire-a/req-18` shows `low` from the env var alone).
  A `settings.json` key named `effort` does nothing (`req-16` stayed at `high`).
  The flag is the natural daemon mechanism: the spawn template already carries flags.
- **Vocabulary.** `low, medium, high, xhigh, max` (the help text and the `/effort` slider
  agree). One hidden extra: `--effort ultracode` is accepted without a warning and sends
  `xhigh` on the wire (`req-14`). The slider names it "ultracode — xhigh + workflows".
  Mapping onto the union: the five named levels match one to one. `ultra` has no exact
  claude twin. The nearest is `ultracode`, which is `xhigh` on the wire plus a
  workflow-orchestration mode, not a higher thinking level.
- **Default.** `high`. Proven twice: a resume without the flag (`req-8`) and the
  invalid-value fallback (`req-12`) both sent `high`.
- **Readback.** Four surfaces. The spawn header says "Opus 5 (1M context) with xhigh
  effort" (`claude-1-spawn-xhigh.txt`). The footer shows `◉ xhigh · /effort` at spawn.
  The `/effort` slider shows the current level. The transcript records `effort` on every
  assistant entry (`claude-8-transcript-effort.txt`) — the same per-session JSONL the
  daemon already mines for the model id, so the daemon can read the true per-turn effort.
  `/status` does NOT show effort (`claude-5-status.txt`).
- **Failure shape.** An invalid flag value is a printed warning plus a quiet fallback:
  "Warning: Unknown --effort value 'banana' — ignoring it and using the default effort."
  The spawn continues at `high` (`req-12`), exit code 0. Not refused, so the daemon must
  validate before the spawn. The transcript states the effort actually used, so a wrong
  value is detectable afterward.
- **Mid-session.** Yes, two ways. `/effort` opens a slider; confirming warns "the full
  history gets re-read on your next message" (a prompt-cache invalidation cost,
  `claude-3-switch-confirm.txt`) and the next turn sends the new value (`req-6`, `max`).
  The switch is "this session only": a later `claude --continue` WITHOUT the flag drops
  back to the default `high` (`req-8`), and `claude --continue --effort low` applies the
  flag to the resumed session (`req-10`). So a ticket-type override applies on every
  spawn, resume included, by always passing the flag.
- **Side calls run their own effort.** Haiku-style utility calls (topic titles) send
  `effort: high` with `thinking: disabled` regardless of the flag (`req-3`, `req-5`).
  A status line reading the wire must read the MAIN turn, or read the transcript.
- **Fallback models.** The flag applies to fable and sonnet the same way (`req-20`,
  `req-24`). Haiku does NOT take it: the CLI accepts the flag, prints no warning, sends
  no `output_config`, and falls back to a thinking budget (`req-22`). The transcript
  tells the truth: the `effort` field is present where applied and ABSENT where dropped
  (`claude-9-effort-across-models.txt`). So the daemon can detect a dropped effort on a
  fallback spawn by reading its own transcript surface.

## codex 0.146.0 (wire: `POST /v1/responses`, field `reasoning.effort`)

- **Mechanism.** `model_reasoning_effort` in `config.toml` — the known case,
  `workspace.mjs` writes it today. The CLI override `-c model_reasoning_effort="x"`
  states the same key per spawn and beats everything, resume included (`req-16`).
- **Vocabulary.** `minimal, low, medium, high, xhigh, max, ultra`. The `/model` picker
  names them Low (default for gpt-5.6-sol), Medium, High, Extra high, and an "Advanced
  Reasoning" submenu with Max and Ultra ("for demanding work using multiple agents").
  On the wire `ultra` is CLAMPED to `max` (`codex-wire/req-9`, `req-11`): footer and
  rollout say `ultra`, the request says `max`, and the tool list does not change.
  Mapping onto the union: `low..max` match one to one, `ultra` matches by name but rides
  as `max`, and codex has `minimal` below the union's floor.
- **Default.** Per model, not one constant: the picker marks `Low` as the default for
  gpt-5.6-sol. The routing.yaml comment already records gpt-5.5 defaulting to `medium`.
- **Readback.** The footer shows `<model> <effort>` (`gpt-5.6-sol low · ~/ws`) and the
  `codex exec` header prints `reasoning effort: <value>`. Both echo the CONFIGURED
  string, not the wire truth: `banana` and `ultra` both show verbatim
  (`codex-5-after-ultra.txt`, the banana exec header). The rollout file records
  `effort` in every `turn_context` payload (`codex-9-rollout-effort-tally.txt`) — also
  the configured string (`ultra` and `banana` appear there). The daemon already parses
  rollouts, so per-turn effort is readable, with that caveat at `ultra`.
- **Failure shape.** The dangerous quiet one. ANY string passes through: the spawn
  accepts `model_reasoning_effort = "banana"`, the header echoes it, and the request
  carries `"effort":"banana"` (`req-8`). Against the real API that is a mid-run 400,
  not a spawn refusal. The daemon's boot validation is the only guard on this lane.
- **Mid-session.** Yes: `/model` picks model and effort per session (`req-11`). The
  switch does not write `config.toml`. On resume the SESSION record wins over the config
  file: a session spawned at `high` stayed `high` after the config changed to `medium`
  (`req-15`, `codex-8-resume-keeps-high.txt`). An explicit `-c model_reasoning_effort`
  on the resume command line wins over the session record (`req-16`, footer follows).
  So a ticket-type override on resume must ride the resume COMMAND, not the config file.

## opencode 1.18.18 (wire: `POST /v1/chat/completions`, field `reasoning_effort`)

Installed pinned after the operator's approval, as the pane-rewind probe was.

- **Mechanism.** The per-agent `opencode.json`, which the daemon writes anyway. The
  model entry's base options state the spawn effort:
  `provider.<id>.models.<id>.options.reasoningEffort` rides the wire as
  `reasoning_effort` (`opencode-wire/req-45`). The model entry can also declare
  `variants` (name → option overrides, e.g. `"xhigh": {"reasoningEffort": "xhigh"}`),
  picked per run with `opencode run --variant <name>`. The interactive TUI takes NO
  variant flag at spawn — the config options are the spawn mechanism there. A top-level
  `"variant"` config key does nothing, and `"default": true` on a variant does nothing
  at spawn (both proven ignored on the wire).
- **Vocabulary.** Config-defined, not harness-fixed. opencode ships no effort words for
  a custom model: whatever string the config states rides the wire verbatim (`ultra`
  included, `req-34`). So the union maps trivially — curia authors the per-model
  mapping itself. Catalog models ship their own variant lists (low/high/max style).
- **Default.** None. A model with no `reasoningEffort` option sends no effort field.
- **Readback.** The footer shows `Build · standin-1 stand-in · xhigh` once a VARIANT is
  chosen (`opencode-5-footer-xhigh.txt`), and nothing for a base-options effort.
  `opencode run` prints no effort at all. The message store (a sqlite db,
  `opencode.db`) records `variant` per assistant message — again only for variants,
  `null` for base options. So a base-options effort reads back NOWHERE: the daemon's
  own config value is the only record.
- **Failure shape.** Two quiet ones. A `--variant` name the model does not declare is
  ignored without a warning, and no effort rides the wire (`req-36`,
  `opencode-2-run-banana.txt`). A garbage string in the options passes through
  verbatim (`req-48`) — a mid-run 400 on a real API, exactly the codex shape.
- **Mid-session.** Yes: the `/variant` command opens a picker of the declared variants
  (`opencode-4-variant-menu.txt`); the footer updates and the next turn sends the new
  value (`req-39`). The TUI persists the last-used model and variant in its per-user
  state and carries it into OTHER workspaces under the same home (proven: a fresh
  workspace inherited `xhigh`). On resume (`--continue`) the config is re-read: a
  changed `reasoningEffort` option applied to the resumed session (`req-46`), so a
  ticket-type override on resume works by rewriting the throwaway config.

## pi 0.84.2 (wire: `POST /v1/chat/completions`, field `reasoning_effort`)

Installed pinned after the operator's approval (`@earendil-works/pi-coding-agent`).

- **Mechanism.** The spawn flag `--thinking <level>`, or the suffix form
  `--model <id>:<level>` (`pi-wire/req-11`). The per-model `thinkingLevelMap` in
  `models.json` maps each level to the provider string that rides the wire, so curia
  controls both the level and its translation for a custom provider.
- **Vocabulary.** Fixed and validated: `off, minimal, low, medium, high, xhigh, max`.
  Mapping onto the union: `low..max` one to one. `ultra` is INVALID on pi (warns, falls
  back). pi adds `off` and `minimal` below the union's floor.
- **Default.** `medium` (`req-10`, no flag). `off` omits the effort field entirely
  (`req-2`).
- **Readback.** The footer always shows `standin-1 • xhigh`
  (`pi-1-spawn-xhigh.txt`) — the one lane where the effort is permanently visible. The
  session JSONL under `<agent-dir>/sessions/` records `thinkingLevel` at start and on
  every change (`pi-7-session-thinking-record.txt`) — a plain file the daemon can read.
- **Failure shape.** The best of the four: a printed warning that names the valid
  values — "Invalid thinking level \"banana\". Valid values: off, minimal, low,
  medium, high, xhigh, max" — then a fallback to `medium`, exit 0
  (`pi-6-invalid-warning.txt`, `req-9`). Still not a refusal.
- **Mid-session.** Yes: `Shift+Tab` cycles the level; the footer and the wire follow
  (`req-13`). There is NO `/thinking` slash command — that text goes to the model as a
  user message, a hazard for a pane driver. The cycle is session-only in the claude
  sense: a bare `-c` resume returns to the DEFAULT `medium` even when the session ended
  at `xhigh` (`req-19`), and `--thinking` on the resume wins (`req-17`). So the flag
  must ride every spawn, resume included.

## What the design at #533 can settle on this evidence

- **The config shape works everywhere.** Every lane takes the effort at spawn from a
  value the daemon fully controls: claude `--effort`, codex `model_reasoning_effort`
  (config or `-c`), opencode the throwaway `opencode.json` model options, pi
  `--thinking`. So `defaults.<type>` as `{model, effort}` beside
  `models.<label>.reasoning_effort`, with type-beats-model precedence, is
  implementable on all four.
- **The override survives a resume on every lane, each by its own rule.** claude and
  pi: pass the flag again on the resume spawn (a bare resume falls back to the
  default). opencode: rewrite the config, the resume re-reads it. codex: the session
  record beats the config file, so the override must ride `-c` on the resume command.
- **No lane refuses a wrong value, so boot validation is the daemon's job.** claude
  and pi warn and fall back (visible, recoverable). codex and opencode send garbage to
  the wire (a mid-run 400 on a real API — the dangerous quiet shape the ticket named).
  The existing `REASONING_EFFORTS` check must extend to the type override, plus a
  per-harness vocabulary check: `ultra` is claude `ultracode` (rides as xhigh +
  workflows), codex `ultra` (rides as max), INVALID on pi, and config-authored on
  opencode. A row naming an effort its model's harness cannot state should be refused
  at boot, as #557 asked.
- **The status line can only show what a surface states.** Per-turn records exist on
  claude (transcript `effort`, honest: absent when a model dropped it), codex (rollout
  `turn_context.effort`, echoes the configured label even when clamped or garbage), and
  pi (session `thinkingLevel`). opencode records only variant picks, nothing for
  base-options effort — there the daemon's own config value is the sole source.
- **Fallback models.** On the claude lane the flag applies to fable and sonnet and is
  silently dropped by haiku (transcript shows the drop). On codex the effort is per
  model in config, so a fallback re-spawn states its own. A fallback chain should
  carry the effort ruling through re-spawns and read the harness record to see whether
  it stuck.
