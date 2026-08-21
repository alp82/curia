# The overseer pane spike (#570)

PROTOTYPE — throwaway evidence for [alp82/curia#570](https://github.com/alp82/curia/issues/570).
The decision ticket [#571](https://github.com/alp82/curia/issues/571) reads this note beside the
research facts in [overseer-terminal/findings.md](../overseer-terminal/findings.md).

Every claim comes off a real run in this container: Claude Code 2.1.220, tmux 3.3a, Node 24.19.0.
The pane ran detached in tmux through `drive.mjs`, which imports the daemon's own paced write path
(`daemon/src/tmux.mjs`). The chat page proof ran the real `TimelineSurface`
(`daemon/src/timeline.mjs`) with its default deps, so the probe exercised the exact pane path the
chat page gives an agent. The model was a local stand-in that logs every request whole, so what the
model saw is read off the wire (`evidence/wire/req-N.json`) and never off a pane rendering. The
pane carried the real overseer standing orders through `--append-system-prompt`
(`seed.mjs`, wire proof in `req-4`).

## Result

The three proofs pass.

1. A live claude pane holds one overseer conversation. It takes operator messages as keystrokes
   and answers in the pane.
2. The chat page reads and writes the pane exactly as an agent pane. No driver, no new code.
3. The take back runs as the pane rewind of ADR-0021, with the proved #542 flow, mid-turn too.

One gap is measured, and it is the one the research predicted: after a rewind, the chat page's
linear transcript scan shows BOTH branches. The fix shape is proved in `branchread.mjs` (about
25 lines): walk `parentUuid` from the last line and feed the daemon's own `parseLine`. The same
gap holds for AGENT panes today, because ADR-0021 already makes their take back a rewind.

## The pane takes operator messages as keystrokes

- `sendText` typed "Which agents run right now?" into the composer, and the answer rendered in the
  pane (`pane-2-turn1.txt`). The wire shows the turn: model `standin-overseer`, system blocks with
  the overseer standing orders, the user message with the CLI's own system-reminder attachment
  (`wire/req-4.json`).
- Message 2 went through the chat page's own `POST /send` — the page's pane write path, dialog
  guard included — and the turn ran (`chatread-2-turn2.jsonl`, `wire/req-6.json`). The page
  journaled `timeline_send … sent`.

## The chat page reads it as an agent pane

- `GET /events` answered `hello` with harness `claude`, detected from the pane's config dir, and
  the transcript found newest-by-mtime — the pane path, driver null (`chatread-1-turn1.jsonl`).
- The items are the agent-pane vocabulary: `prompt` for the operator, `say` for the overseer.
- The dialog guard carries over unchanged: a `/send` while the rewind menu owned the pane refused
  with 409 and words, and nothing was typed into the menu
  (`chatread-6-send-refused-during-menu.txt`, `pane-11-menu-reopened.txt`).

## The note batch rides one message

ADR-0023 batches queued curia notes into the operator's message as prefixed lines. The pane form
works through a bracketed paste, which `tmux.mjs` does not have yet:

1. `tmux set-buffer` with the note line plus the operator line.
2. `tmux paste-buffer -p` into the composer. The composer keeps the newline and does not submit
   (`pane-4-notebatch-composer.txt`).
3. One Enter submits. The wire shows ONE user message with the newline intact (`wire/req-8.json`).

The later rewind removed the note with the message at the same boundary (`wire/req-10.json`), so
the ADR-0023 rule stands: curia returns the notes to its queue from its own journal.

## The take back is the pane rewind

The #542 flow ran unchanged on the overseer pane:

- Double Escape opened the rewind menu. The menu lists every operator turn, the FIRST one
  included — so claude offers landings below curia's legal floor, and curia must count its own
  selection (`pane-6-rewind-menu.txt`, the ADR-0023 floor).
- One Up plus Enter picked the note-batch turn. The confirm screen names the message and says
  "The conversation will be forked. The code will be unchanged." Enter restored the conversation
  (`pane-7-rewind-confirm.txt`).
- The composer came back PREFILLED with the taken-back message, both lines
  (`pane-8-rewound-prefill.txt`). `C-c` cleared it (`pane-9-prefill-cleared.txt`), so the
  dashboard composer stays the one editable copy, as ADR-0021 rules.
- The wire proves the landing: the next turn's context holds turns 1 and 2 and the corrected
  message, and the note-batch exchange is gone (`wire/req-10.json`).

Mid-turn, the press acts at once:

- A streaming answer stopped mid-word on ONE Escape, with the pane's Interrupted marker
  (`pane-12-interrupted.txt`). The transcript keeps the partial answer plus a
  `[Request interrupted by user]` line, and the chat page reads both
  (`chatread-7-interrupted.jsonl`).
- Double Escape then opened the menu, and the landing before the interrupting message worked the
  same way (`pane-14-midturn-takeback.txt`).
- The menu after a fork lists the ACTIVE branch only — the taken-back turn is not offered
  (`pane-13-menu-after-fork.txt`). Blind selection counting must therefore count on the active
  branch, which is the same branch the fixed reader walks.

## The read after a rewind: the one gap

- The transcript stays ONE file with ONE session id through spawn, rewind, fork, and interrupt
  (`transcript-1..3`). Resume identity is intact, so #569's rehydration path holds.
- The rewind itself writes NOTHING to the transcript. The fork becomes visible only when the next
  message lands with an earlier `parentUuid` (`transcript-1-after-rewind.jsonl` tail). Between
  the press and the next turn, curia's own journal receipt is the only record of the landing —
  ADR-0023's receipt event must carry the landing point, and the chat draws from it.
- The chat page's linear scan shows both branches after the fork
  (`chatread-5-after-fork.jsonl`). The branch-aware walk in `branchread.mjs` yields exactly the
  active branch through the daemon's own `parseLine` (`branchread-final.jsonl`).
- This gap is NOT pane-specific. ADR-0021 already makes the agent take back a rewind, so the
  agent chat shows both branches after a take back today. The build fix lands once, in the
  tailer, for both chat kinds.

## The spawn dialogs

- The daemon's agent seed (`workspace.mjs`) suppressed the trust and onboarding dialogs, verbatim.
- One NEW first-spawn dialog appeared: an env `ANTHROPIC_API_KEY` asks for approval
  (`pane-0-apikey-dialog.txt`). The overseer credential arrives exactly that way (ADR-0014). The
  approval persists in the config dir's `.claude.json` as
  `customApiKeyResponses.approved: ["<key tail>"]`, so the pane seed adds that key. The build
  must verify the exact tail length against the deployed CLI.

## Decision facts

- A pane overseer needs NO new read or write code on the chat page for normal turns. The pane
  path — harness detection, newest-by-mtime, send-keys — serves it as it serves an agent.
- The take back becomes the ADR-0021 flow: Escape interrupts at once, double Escape opens rewind,
  blind counting picks the landing, `C-c` clears the prefill, curia enforces the floor and writes
  the receipt. The ADR-0023 journal append retires if #571 picks panes.
- The one build change the chat needs: the tailer follows the active branch by `parentUuid` for
  BOTH chat kinds, and the take-back receipt carries the landing point for the press-to-next-turn
  window.
- Notes batch into the message through a bracketed paste, one submit, newline kept. `tmux.mjs`
  gains a paste write beside `sendText`.
- The pane seed extends the agent seed with `customApiKeyResponses` for the env credential.
- Costs, hosting, restart rehydration, and MCP identity are the #569 facts and stand unchanged.
