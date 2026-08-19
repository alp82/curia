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

## opencode (pending the install approval)

## pi (pending the install approval)

## What the design at #533 can settle on this evidence

- Every lane takes the effort at spawn from a value the daemon fully controls
  (claude: flag or env var; codex: config key or `-c`). Per-spawn override is universal
  on the two proven lanes, resume included, so `defaults.<type>` as `{model, effort}`
  with type-beats-model precedence is implementable.
- Boot validation against `REASONING_EFFORTS` must also map per harness: claude refuses
  nothing and warns, codex refuses nothing and sends garbage to the real API. The union
  value `ultra` needs a per-harness translation table (`ultracode` on claude, `ultra`
  accepted but riding as `max` on codex) or a rule that no model maps it.
- The status line can read the chosen effort back from the harness's own record
  (claude transcript per assistant turn, codex rollout per turn_context), with one
  caveat: the codex record states the configured label, not the clamped wire value.
