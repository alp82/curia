# Changing a live agent's model, per harness (#561)

PROTOTYPE — throwaway evidence for [alp82/curia#561](https://github.com/alp82/curia/issues/561).
The build handoff (#533) reads this note as ground truth.

Every claim below comes off a real run in this container. Each harness ran in a detached
tmux pane through `drive.mjs`, which imports the daemon's own paced write path from
`daemon/src/tmux.mjs`. Each harness talked to a local stand-in model server that logs every
request whole. The model a turn states is read off the request body, never off a pane
rendering. Raw wire captures sit in `evidence/`, and `req-N` below names those files.
The stand-in refuses any model id that contains `cold`, with the provider's own error
shape, so the cooled-model failure is measured and not imagined.

## claude 2.1.220 (wire: `POST /v1/messages`, field `model`)

- **Mechanism.** `/model <id>` typed blind into the composer. The CLI VALIDATES the target
  first — a one-token non-streaming completion on the new model (`claude-wire/req-2`) —
  then asks one confirm ("Switch model? ... the full history gets re-read on your next
  message", `claude-2-switch-confirm.txt`). One Enter confirms. The switch also writes
  `"model": "<id>"` into the config dir's `settings.json` ("saved as your default for new
  sessions") — a persistence side effect the daemon owns, because it owns the config dir.
- **Survives.** The conversation: the next request carries the full history on the new
  model (`req-4`, 4 messages on `standin-2`). The transcript identity: ONE session JSONL
  before and after, so the meter goes on reading the same file
  (`claude-4-transcript-model.txt`). The queued composer text: ONLY under a cut-and-paste
  discipline — see the hazard below.
- **The composer hazard.** Text already sitting in the composer concatenates with the
  typed command: `remember the pelican/model standin-1` went to the MODEL as a plain user
  message, no switch happened, and the queued text was spent (`claude-7-queued-eaten.txt`,
  `req-6`). The discipline that works: `Ctrl+U` cuts the composer, type `/model <id>`,
  Enter, confirm, `Ctrl+Y` pastes the cut text back (`claude-8-queued-survives.txt`).
  Escape does NOT clear the composer on this lane.
- **Readback.** Three surfaces. `/status` states `Model: <id>` (`claude-5-status-model.txt`).
  The transcript states `message.model` on every assistant entry — the exact field
  `daemon/src/usage.mjs#claudeTail` already reads, so the meter and the status line follow
  the switch one turn later with no new code. The transcript also records the `/model`
  command itself as user entries. The footer at rest shows effort but NO model.
- **Failure shape.** The best of the lanes: the validation probe runs BEFORE the switch,
  so a refused model never becomes the session's model. `/model standin-cold` printed
  `API error: 403` with the API's own message in the pane, and the next turn still ran the
  old model with the conversation intact (`claude-9-cold-refusal.txt`, `req-9`).
- **Resume.** A bare `claude --continue` KEEPS the switched model — the switch persisted
  into `settings.json` (`req-12`, `standin-1` after the switch back). An explicit
  `--model` on the resume beats it (`req-14`, `standin-2`). The daemon's spawn template
  always passes `--model`, so a respawn always states the routing pick; the settings write
  cannot leak into another agent because every agent gets its own config dir.
- **Vocabulary.** `/model` takes any string and validates it live against the account, so
  the daemon can type either the routing label (`opus` is a CLI alias) or a concrete id.
  The transcript answers with the id the API resolved, which is the id→label direction
  `modelName()` already renders.

## codex 0.146.0 (wire: `POST /v1/responses`, field `model`)

- **Mechanism.** The `/model` PICKER only: `/model` + arrows + Enter picks the model, a
  second submenu picks the effort, Enter confirms ("Model changed to gpt-5.6-terra
  medium", `codex-5-switched-footer.txt`). The picker lists ONLY the built-in OpenAI
  catalog (gpt-5.6-sol/terra/luna, gpt-5.5, gpt-5.2 — `codex-2-model-picker.txt`); a
  custom or out-of-catalog id is not offered. `/model <id>` with an argument is NOT a
  command — the whole line went to the model as a user message (`codex-3-slash-arg-eaten.txt`,
  `req-3`). The out-of-catalog path is a kill + `codex resume --last -m <id>` (`req-7`).
  The provider does not change on a picker switch: the request went to the same
  configured `model_providers` base URL with the new model id (`req-4`).
- **Survives.** The conversation: the post-switch request carries the full history
  (`req-4`, input length 10). The transcript identity: ONE rollout file throughout, so the
  meter reads the same file. The queued composer text: the same concatenation hazard as
  claude (`codex-7-queued-eaten.txt`), and the same recovery — `Ctrl+U` cuts, `Ctrl+Y`
  pastes back, both proven on this lane.
- **Readback.** The footer states `<model> <effort>` permanently and follows the switch at
  once. The rollout records `model` in every `turn_context` payload
  (`codex-6-rollout-model.txt`) — the daemon already parses rollouts. The switch line
  itself ("Model changed to ...") is pane text, not a rollout event.
- **Failure shape.** The dangerous quiet one, exactly the effort-probe shape: the switch
  ACCEPTS any model (`-m standin-cold` spawned, footer said `standin-cold medium`,
  plus a "Model metadata not found" warning that also fires for any custom id). The
  refusal lands on the NEXT TURN as a pane error quoting the API —
  `unexpected status 404 ... The model 'standin-cold' does not exist or you do not have
  access to it` (`codex-10-cold-turn-fails.txt`). The turn is lost; the conversation
  stands. So on this lane the daemon must refuse a cooled or unknown target BEFORE
  driving the switch.
- **Resume.** The session record wins over `config.toml`: a bare `codex resume --last`
  kept the picker-switched model against a config that still said `standin-1` (`req-6`).
  An explicit `-m` on the resume command beats the session record (`req-7`) — the same
  rule #559 proved for effort. So a daemon-driven switch survives a respawn only if the
  resume command states the new model.
- **Vocabulary.** The picker speaks the catalog's own ids, which are exactly the values
  `models.<label>.id` holds (`gpt` → `gpt-5.6-sol`). The daemon must translate
  label→catalog-position to drive the picker blind (arrow count), or use the resume path
  with `-m <id>`, which takes the id directly and is positionless. The rollout states the
  id back, and `modelName()` renders it.

## opencode (pending)

The container ships no opencode CLI. The operator's answer on installing the pinned
CLI decides whether this lane runs — the round is open.

## pi (pending)

Same as opencode: the pinned CLI awaits the operator's answer.

## What the design at #553's build can settle on this evidence

- **A pane-driven switch is real on both installed lanes, with one discipline.** Cut the
  composer (`Ctrl+U`), drive the switch, paste back (`Ctrl+Y`). Typing a command into a
  non-empty composer sends the concatenation to the model as text on BOTH lanes — the
  same class of hazard ADR-0021's rewind prototype found, with the same cure.
- **The daemon must validate the target before driving the switch.** claude self-checks
  (a refused model never lands); codex accepts anything and burns the next turn. One
  boot-time/cooling check in the daemon covers both.
- **The meter survives on both lanes.** One transcript file per session on both; the
  per-turn model is stated in it (`message.model` / `turn_context.model`), which is the
  field `usage.mjs` already keys on.
- **A switch does not survive a respawn by itself on codex, and survives by accident on
  claude.** The rule that works everywhere: the daemon records the switched label and
  states it explicitly on every later spawn/resume command, exactly as #559 concluded
  for effort.
