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
- **Vocabulary.** Both directions proven on one switch (`claude-11-alias-seam.txt`).
  Typed `/model opus` — the routing label, which is also a CLI alias: the CLI accepted it
  WITHOUT the validation probe (it knows its own aliases), the wire stated
  `claude-opus-5` (`req-16`), and the transcript's assistant entry states the same id —
  the field `modelName()` renders. `settings.json` keeps the label as typed. An unknown
  string (`standin-2`) takes the validation probe instead. So the daemon can type the
  label for anthropic models and must type `models.<label>.id` for anything else.

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

## opencode 1.18.18 (wire: `POST /v1/chat/completions`, field `model`)

Installed pinned after the operator's approval, as the #559 probe was.

- **Mechanism.** The `/models` picker, and it is the ONE mechanism that works on a live
  session. It lists the config-declared models plus the catalog, and it has a SEARCH box:
  the daemon types the model name to filter and presses Enter — deterministic, no arrow
  counting (`opencode-2-model-picker.txt`). No confirm dialog; the footer flips at once.
- **Survives.** The conversation: the post-switch request carries the full history
  (`opencode-wire/req-4`, 4 messages on `standin-2`). One session in the store throughout.
  The queued composer text: `Ctrl+U` clears, but `Ctrl+Y` does NOT paste back on this
  lane — the daemon must retype the queued text itself.
- **Readback.** The footer shows `Build · <model> <provider>` permanently and follows the
  switch. The store (`opencode.db`, table `message`) records `modelID` and `providerID`
  on every assistant message (`opencode-5-db-model.txt`) — a per-turn surface, though not
  one `usage.mjs` reads today. The per-user state file
  (`~/.local/state/opencode/model.json`) records the last pick.
- **Failure shape.** The quiet one: the picker accepts `standin-cold`, the footer says it,
  and the NEXT turn fails with the API's message printed in the conversation area
  (`opencode-6-cold-turn-fails.txt`). The turn is lost; the conversation stands.
- **Resume.** The strictest lane: the RESUMED session always continues on its own last
  model. A bare `--continue` kept the switch (`req-9`). `--model` on the resume command
  LOST to the session record (`opencode-8-resume-flag-loses.txt`, `req-10`), and a
  rewrite of `model.json` lost too (`req-11`). `--model` works on a FRESH session
  (`req-12`). So a daemon-driven switch on this lane must go through the pane picker,
  and once made it survives every respawn by itself — nothing outside the pane can
  override it afterward.
- **Vocabulary.** The picker speaks the config's own model ids, and curia writes that
  config (`opencode.json`), so label→id is curia's own file; the db states the id back.

## pi 0.84.2 (wire: `POST /v1/chat/completions`, field `model`)

Installed pinned after the operator's approval (`@earendil-works/pi-coding-agent`).

- **Mechanism.** `/model` opens a picker with a type-to-filter prompt over the models of
  `~/.pi/agent/models.json` — a file curia would write. The daemon types the name and
  presses Enter (`pi-2-model-picker.txt`). No confirm; the footer flips at once. `--models`
  patterns also enable Ctrl+P cycling, but the picker needs no such pre-declaration.
- **Survives.** The conversation: the post-switch request carries the full history
  (`pi-wire/req-2`, 4 messages). ONE session JSONL throughout. The queued composer text:
  the same concatenation hazard (`pi-4-queued-eaten.txt`), and the same cure — `Ctrl+U`
  cuts, `Ctrl+Y` pastes back, both proven.
- **Readback.** The best transcript of the four: the session JSONL records an explicit
  `model_change` event (provider + modelId + timestamp) on every switch, AND `model` on
  every assistant message (`pi-5-session-model-record.txt`). The footer names the model
  permanently.
- **Failure shape.** The picker accepts `standin-cold`; the next turn prints
  `Error: 404: {...model_not_found...}` in the pane (`pi-6-cold-turn-fails.txt`). The
  turn is lost; the conversation stands.
- **Resume.** A bare `-c` resume KEEPS the switched model — the session record replays
  its `model_change` (`req-5`, unlike effort, which #559 showed falling back to the
  default). `--provider <p> --model <id>` on the resume wins over the record (`req-6`).
- **Vocabulary.** The picker and the flags speak the ids of `models.json`, which curia
  authors — the seam is curia's own file in both directions, as on opencode.

## What the design at #553's build can settle on this evidence

- **A pane-driven switch is real on all four lanes.** claude: `/model <id>` typed as
  text plus one confirm. codex: the `/model` picker by arrows (catalog models only;
  out-of-catalog ids ride a kill + `resume -m`). opencode: the `/models` picker with
  type-to-filter. pi: the `/model` picker with type-to-filter.
- **One composer discipline everywhere.** Typing into a non-empty composer concatenates
  and sends the whole line to the model as prose — proven on all four lanes. The cure:
  `Ctrl+U` cuts first. `Ctrl+Y` pastes the cut text back on claude, codex and pi;
  opencode has no paste-back, so the daemon retypes the queued text there. This is the
  same hazard class ADR-0021's rewind prototype found, with the same cure.
- **The daemon must refuse a cooled or unknown target BEFORE driving the pane.** Only
  claude validates at the switch (and only for ids it does not know as aliases); codex,
  opencode and pi all accept the switch and burn the operator's next turn on the API
  error. The refusal is readable off the pane on every lane, but by then the turn is
  lost. The daemon already knows every hold, so the check is one lookup.
- **The conversation and the transcript identity survive on every lane.** One
  transcript/rollout/store/session file before and after; the full history rides the
  first post-switch request. The per-turn model is stated on every lane: claude
  `message.model` and codex `turn_context.model` (the fields `usage.mjs` already keys
  on), opencode `message.modelID` in `opencode.db`, pi `model_change` events plus
  `model` per assistant message.
- **The readback differs at rest.** codex, opencode and pi name the model in the footer
  permanently. claude's footer at rest names none — `/status` and the transcript are its
  surfaces. The status line should therefore read the transcript, never the pane.
- **The resume rule is per lane, and #559's conclusion generalizes with one exception.**
  State the model explicitly on every spawn and resume: claude `--model` beats its own
  settings persistence, codex `-m` beats the session record, pi `--model` beats the
  replayed `model_change`. The exception is opencode: the resumed session ALWAYS
  continues on its own last model — flag, config and state file all lose — so there the
  switch itself is durable and the daemon must drive the picker again to change it.
- **The vocabulary seam holds on all four.** claude resolves its own aliases (typed
  `opus`, wire said `claude-opus-5`) and validates unknown ids live. codex speaks its
  catalog ids, which are exactly `models.<label>.id`. opencode and pi speak the ids of
  config files curia itself writes. Every lane states the concrete id back on a per-turn
  record, which is the direction `modelName()` renders.
