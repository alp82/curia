# Prototype: the non-PTY timeline attach surface

Ticket: [#73](https://github.com/alp82/curia/issues/73). Built to the ranking in
[#72](https://github.com/alp82/curia/issues/72)'s report
([`docs/research/dual-geometry-attach.md`](../../docs/research/dual-geometry-attach.md)):
recommendation 1, **the worker's own transcript for reading and `tmux send-keys`
for writing**.

Throwaway. No tests, no config validation, no journal, no asserted config. If it
wins it gets rewritten the way #69's variant A was rewritten by
[#70](https://github.com/alp82/curia/issues/70).

## Why this shape

#72 settled the geometry question structurally: one PTY carries one `winsize`,
so the program renders one grid, and every relay downstream can only pick a
winner, take a min or max, freeze and clip, or pan. None of those is a second
rendering. A timeline has no grid at all, so each device lays the same content
out at its own width for free.

The two halves are things curia already owns:

- **Read** — every worker writes a structured, geometry-free transcript under its
  own `CLAUDE_CONFIG_DIR`. Append-only, so a late joiner replays the whole run
  for free. The server tails it.
- **Write** — `tmux send-keys` drives a session with **zero attached clients**,
  so the write path needs no geometry either. The pane never learns that two
  devices exist.

Nothing about dispatch changes. The PTY stays the worker's execution home, the
readiness signal and the usage-limit signal.

## Run

```sh
./run.sh          # lab worker + timeline server + Serve rule, prints both URLs
./run.sh --stop   # server down, serve rule withdrawn, lab session gone
```

`run.sh` prints two URLs for the same session:

```
timeline   https://<box>.<tailnet>.ts.net:8444/?session=curia-lab
terminal   https://<box>.<tailnet>.ts.net:8443/?arg=curia-lab
```

The second is today's ttyd surface, unchanged, so the two can be judged side by
side. Open the timeline on **a real phone and a real desktop at once** — #69's
lesson is that a narrowed desktop window is not a phone.

It touches nothing the daemon owns: its own port (4272), its own Serve port
(8444 — not attach's 8443, not the preview range 8500–8599), its own tmux
session, its own config dir under the workspace root.

## The lab worker

`run.sh` spawns a real Claude Code worker in `curia-lab`, shaped like a curia
worker — its own `CLAUDE_CONFIG_DIR`, the host credential store shared not
copied (#53), onboarding pre-seeded so no first-spawn dialog appears, the same
`--permission-mode bypassPermissions` argv the claude harness uses. It is **not**
dispatched by the daemon: no ticket is claimed, no MCP side channel, no Stop
hook. The transcript it writes is the same artifact either way, which is the
thing under test.

It reads markdown under `~/curia-work/lab-timeline/docs/research` and appends
notes, one file at a time, so there is a steady stream of tool calls and prose to
watch. Type at it from either device; a message sent mid-turn is queued and taken
at the end of the turn.

## What the surface does

- Replays the whole run on connect, then streams new items over SSE.
- Renders prose, tool calls (name + a one-line brief) with their results folded
  in, and prompts. Long prompts collapse behind a summary.
- **One shared composer.** tmux gives two attached clients one composer, and
  #73's pass-bar item 4 asks for that behavior back, so a draft is broadcast to
  the other device as it is typed. Here it is an explicit broadcast rather than a
  side effect of sharing a grid — an incoming draft is ignored while this device
  has typed in the last 1.5 s, so two people typing at once do not fight.
- An `esc` button, because the one thing a grid-less surface cannot do is send a
  key. Interrupting a turn is the key that matters.
- Origin-must-equal-Host on every POST, which is ttyd's `-O` by hand, and the
  same `^curia-` session whitelist the ttyd wrapper enforces.

## Known, before anyone judges it

- **Thinking is not in the transcript.** Extended-thinking blocks are stored
  signature-only, with the text empty — measured across #67's run (41 blocks, all
  zero length) and the lab worker's. The terminal shows thinking live; the
  timeline cannot show it at all. That is a real division-of-labor fact, not a
  rendering gap.
- **Liveness is per message, not per token.** Nothing appears while a reply is
  being written. Median gap between transcript writes on a real run is ~1 s, so
  it feels like steady progress, not like a stall — but it is not a token stream.
- **A mid-turn message is queued, not steered.** That is the TUI's own behavior,
  reached through the composer. There is no `priority:"now"` equivalent on this
  path (#72 measured one on the `stream-json` lane, which is the graduation path).
- **The transcript format is undocumented.** A parse break is a real risk. This
  prototype fails quietly on an unknown line shape; a landed version must fail
  loudly.
- **The claude lane only.** The codex lane writes its own rollout JSONL under
  `CODEX_HOME/sessions/`, with a different vocabulary. A landed version needs a
  per-backend reader, the same shape as #39's per-backend harness table.
- **Auth is tailnet membership**, exactly like the ttyd surface it sits beside.
  Hardening is the same standing pre-production item (#30), not PoC work.
