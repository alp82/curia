# #538 findings — the native dialog, measured live

Method: the real claude TUI (2.1.220) and the real codex TUI (0.146.0) ran in tmux panes
against stand-in model servers, so every capture in `evidence/` is the real renderer's
output and no capture is a reconstruction. The stand-in logged every request body, so
each keystroke answer below is proven by the tool_result the harness posted back.

## The captures

| file | dialog | footer |
| --- | --- | --- |
| claude-1-trust.txt | folder trust prompt | `Enter to confirm · Esc to cancel` |
| claude-2-apikey.txt | custom API key prompt | `Enter to confirm · Esc to cancel` |
| claude-3-bypass.txt | bypass-permissions warning | `Enter to confirm · Esc to cancel` |
| claude-4-ask-single.txt | AskUserQuestion, one question | `Enter to select · ↑/↓ to navigate · Esc to cancel` |
| claude-5-ask-single-down.txt | same, after one Down | same |
| claude-6-ask-multi.txt | AskUserQuestion, multiSelect | same |
| claude-7-ask-multi-toggled.txt | same, one box checked | same |
| claude-8-ask-multi-review.txt | the Submit tab review screen | same |
| claude-9-ask-long.txt | AskUserQuestion, long labels | same |
| claude-10-ask-two.txt | AskUserQuestion, two questions | `Enter to select · Tab/Arrow keys to navigate · Esc to cancel` |
| claude-11-model.txt | /model picker | `Enter to set as default · s to use this session only · Esc to cancel` |
| codex-1-trust.txt | directory trust prompt | `Press enter to continue` |
| codex-2-model.txt | /model picker | `Press enter to confirm or esc to go back` |

The rewind menu capture from #542 (`prototypes/pane-rewind/evidence/claude-2-menu.txt`)
is the parse-failure fixture: its entries carry no numbers, so the parser refuses it and
the guard banner stays.

## Key mechanics, measured

Claude, single-select (AskUserQuestion, trust, API key, bypass, /model):

- A digit key picks THAT option and submits, in one keystroke. Proven: digit `2` on the
  long picker returned `"...\"=\"Write the open set to its own table...\""` to the harness.
- Arrows move the `❯` selector. Enter submits the selected option. Proven: Down then
  Enter returned `"Redis"`.

Claude, multiSelect:

- A digit key TOGGLES that checkbox and does not submit. Proven: digit `3` checked
  `[✔] Feed` while the selector stayed on option 1.
- Enter toggles the selected row. Tab jumps to the Submit tab, which shows a review
  screen (`1. Submit answers / 2. Cancel`); Enter there submits. Proven: the harness
  received `"Home, Feed"`.

Claude, several questions in one call:

- One tab per question plus a Submit tab. A digit answers the current question and
  advances to the next tab. Proven: digits `1` then `2` then Enter on the review screen
  returned both answers.

Codex:

- Digit keys are inert (measured on the trust prompt: `2` changed nothing).
- Arrows move the `›` selector, Enter confirms. So a codex answer is
  `Down × delta, Enter`.

Both TUIs render the picker inside the pane with a stable text shape: an optional header
line (`☐ Cache` or the tab bar `←  ☐ Preview  ☐ Terminal  ✔ Submit  →`), a question
block, numbered options `1.`..`N.` with wrapped description lines beneath, a selector
(`❯` claude, `›` codex) and the footer chrome the daemon's `DIALOG_MARKERS` already
match.

Claude appends two synthetic entries to every AskUserQuestion list: `Type something.`
(free text) and `Chat about this` (drop back to the conversation). A web copy must
carry both, and both route to the chat composer rather than to a keystroke.

## A blind spot in today's guard, found by the captures

The multiSelect review screen (`claude-8-ask-multi-review.txt`) renders WITHOUT any footer
chrome — no `Enter to ... ·` line at all. `detectDialog` anchors on that chrome, so the
guard banner CLEARS while the review screen still owns the pane, and a composer send in
that window types into the review screen blind. The web copy sidesteps it: the card
submits with one `Tab, Enter` burst, so the page never sits idle on the review screen.
The parse (`parseDialog`) refuses the same capture for the same reason, which keeps the
two classifiers consistent.

## Sizing facts

- The daemon's `detectDialog` classifies on the pane TAIL (20 lines). The parser must
  read the WHOLE pane, anchored on the footer, because a long option list overflows 20
  lines (claude-9-ask-long.txt is 18 lines of menu body alone).
- AskUserQuestion is bounded: at most 4 questions × 4 options, plus the 2 synthetic
  entries — so a menu never exceeds one 32-row pane in practice.
