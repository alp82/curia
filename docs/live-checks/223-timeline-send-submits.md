# Live check: a timeline send reaches a live composer as a submit (#234)

Ticket: [alp82/curia#234](https://github.com/alp82/curia/issues/234), on the map
[Curia gets better](https://github.com/alp82/curia/issues/147). Run on 2026-08-05 on the box
against the live daemon (commit `790b76e`, carrying the #223 fix `cc81838`). Harness versions:
codex 0.146.0 with model `gpt-5.6-sol`, Claude Code 2.1.220 with model `opus`.

The #223 fix paces every pane write 1.5 s apart, because codex 0.146 folds keystrokes that arrive
inside about a second into one paste ([#176](https://github.com/alp82/curia/issues/176), section 4).
Three unit tests pin the spacing against a fake tmux. This check measures the one thing they
cannot: that 1.5 s clears the real fold window on a real pane.

## Method

Two lab sessions on the daemon's own tmux socket, one per harness, named `curia-lab-223-*` so no
ticket sweep sees them. Each ran its real TUI from the daemon's own spawn template, in a throwaway
config dir shaped by the dispatcher's seed (`workspace.mjs`): a trusted-cwd `config.toml` plus a
copied `auth.json` for codex, the onboarding-complete `.claude.json` plus `settings.json` for
claude. The timeline resolves a lab session's harness from that dir on disk — the fallback the
unconditional gap exists to serve.

Each probe answered its spawn prompt, then sat at its composer. The measured send was one
`POST /send` through the production path: Tailscale Serve on `:8444` into the daemon's timeline
surface, identity checked, then the paced per-pane queue. Timestamps are all one clock — the box's.

## 1. The codex lane: the send submits, at the 1.5 s pace

- `POST /send` at 10:40:24.211. curl returned `{"ok":true}` after 1.57 s — the queue's gap,
  visible from outside.
- Journal: `timeline_send … outcome=sent` at 10:40:25.816.
- Rollout: `task_started` at 10:40:25.831 and the probe text as a `user_message` at 10:40:25.863 —
  **1.62 s after the post**. The Enter submitted the composer the moment it landed.
- The agent answered `SUBMITTED` at 10:40:31.66, and `task_complete` closed the turn.

No fold: the message did not sit in the composer, no newline joined the text, one turn started per
send. 1.5 s clears the real fold window on codex 0.146. No wider value is needed.

## 2. The claude lane: the gap did not break the lane that worked

- `POST /send` at 10:41:27.726. curl returned `{"ok":true}` after 1.60 s.
- Journal: `timeline_send … outcome=sent` at 10:41:29.342.
- Transcript: the probe text as a `user` line at 10:41:29.353 — **1.63 s after the post**.
- The agent answered `SUBMITTED` at 10:41:31.129.

The claude composer submits on the late Enter exactly as #74/#75 measured it does on an immediate
one. The lane pays 1.5 s of latency per send and loses nothing.

## Verdict

A timeline `/send` reaches both live composers as a submit. Post to first transcript line: 1.62 s
on codex, 1.63 s on claude — the pace itself, plus milliseconds. The 1.5 s value stands.
