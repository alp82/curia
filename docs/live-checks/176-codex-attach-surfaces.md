# Live check: the timeline's codex harness — dialogs, images, queued input (#176)

Ticket: [alp82/curia#176](https://github.com/alp82/curia/issues/176), on the map
[Curia gets better](https://github.com/alp82/curia/issues/147). Run on 2026-08-05 on the box
against codex 0.146.0 with the operator's ChatGPT credential, model `gpt-5.6-sol`. This is the
capture the gap inventory (`docs/research/codex-lane-gaps.md`, gaps 7 to 10) said each fix starts
with.

Every run was disposable: a throwaway `CODEX_HOME` seeded from `~/.codex/auth.json`, a scratch
work directory, the daemon's own spawn template (`--dangerously-bypass-approvals-and-sandbox
--dangerously-bypass-hook-trust`, TUI in a tmux pane on a private socket). The image probe used a
one-file stdio MCP server that returns an MCP `image` content block — the exact shape
`inboundContent` (`images.mjs`) produces — with a 120×80 solid-red PNG as cargo.

## 1. Gap 7: codex dialogs carry their own chrome, and the veto holds

Two dialogs captured verbatim:

- directory-trust prompt: footer `Press enter to continue`
- `/model` picker: footer `Press enter to confirm or esc to go back`

Neither carries a middot or `↑/↓ to navigate`, so both claude markers miss them. Both dialogs
replace the composer AND the `<model> <effort> · <cwd>` status footer, so the codex ready marker
(`·\s[~/]`) and a real dialog never share a pane tail. The composer-veto design transfers
unchanged.

**Fix**: a third marker in `DIALOG_MARKERS` (`timeline.mjs`): `/Press enter to [^\n]{1,60}/`.

## 2. Gap 8: an MCP image block reaches the codex model — no drop

The agent called the test server's `get_image` tool and answered: "Dominant color: red.
Approximate dimensions: 120 × 80 pixels." Both facts are exact, and neither is stated in any
text the agent saw. A human who answers an escalation with a screenshot is seen on this lane.
Measured parity — no fix needed.

## 3. Gap 9: the transcript vocabulary moved under the fix

The image arrives in the rollout inside a tool output as
`{"type": "input_image", "image_url": "data:image/png;base64,…", "detail": "original"}` — and the
capture showed two vocabulary breaks in front of the missing `[image]`:

- On 0.146 with `gpt-5.6-sol`, an MCP call is not a namespaced `function_call`. The model writes
  a `custom_tool_call` named `exec` whose `input` is raw JS driving `tools.mcp__<server>__<tool>`,
  and a `custom_tool_call_output` answers it. Both types were unknown to `codexItems`, so every
  MCP call on a live codex agent raised the timeline's loud parse failure.
- A tool output is no longer always a string. `custom_tool_call_output.output` is an array of
  content blocks, and plain `function_call_output` grew the same array form (measured on the
  `wait` tool). `String(output)` on that array renders `[object Object]`.

**Fix** (`transcript.mjs`): `codexItems` now reads `custom_tool_call` and
`custom_tool_call_output`; tool outputs flatten arrays, with each image block standing in as
`[image]`; a `message` whose content carries an image block renders an `[image]` note, matching
the claude harness.

## 4. Gap 10: queued input is a non-issue on codex

A mid-turn send during a live 30-second turn was written to the rollout at the moment it was
queued — as an ordinary `response_item` user `message` plus an `event_msg user_message`,
timestamped mid-turn, tagged with the running turn's id. There is no queue event type and none is
needed: the claude harness needs `queue-operation` because it withholds the user message until the
turn picks it up; codex writes the message immediately, so `codexItems` already renders the moment
another device's input became visible. No fix.

One trap worth recording: two keystroke bursts that arrive within about a second are treated as
one paste, so the first probe's "queued" line merged into the submitted prompt as a newline. A
driver that types into a codex pane must pause between text and Enter.
