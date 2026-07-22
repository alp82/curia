# Orca headless: empirical verification

Resolves [#19](https://github.com/alp82/curia/issues/19) — hands-on check of the four source-inferred claims from the [Orca eval](orca.md), run 2026-07-22.

## Test environment

- **Box**: Alp's desktop (Arch Linux, 32 cores, 91 GB RAM) standing in for the Hetzner box. Claims 1/2/4 are functional and carry over; footprint numbers are machine-independent RSS.
- **Display**: real Wayland/X session, **no Xvfb** (not installed). A true headless box adds Xvfb at roughly 50–100 MB RSS on top of the numbers below.
- **Orca**: production build at `/opt/stably-orca`, driven via `orca-ide` CLI (`orca serve` headless mode; CLI reports no version string).
- **Agents**: Claude Code v2.1.217 (`--dangerously-skip-permissions`), Codex v0.145.0 (YOLO mode, gpt-5.5).
- **Clients**: `orca terminal send/read` (CLI) + the serve-printed web client URL in Chrome — two genuinely independent clients on one runtime.

## Claim 1 — Concurrent multi-writer input: PASS

Setup: one Claude Code worker in an Orca worktree; web client and CLI both writing into the same PTY, alternating within ~1 s of each other.

Result: the Claude input line read `hello from CLI WEB1 CLI1 WEB2 CLI2` — every keystroke from both clients landed, interleaved in exact send order. No input lock, no dropped writes, no error. The substrate hard-filter from the session-identity decision (concurrent multi-client PTY attach) holds.

## Claim 2 — In-flight turn survives `orca serve` restart: FAIL (survives as a process, lost to the operator)

Setup: Claude mid-turn running a 4-minute timestamped bash tick loop; `orca serve` SIGTERMed at T+58 s of the tool call; ~35 s downtime; serve restarted.

What survived:

- The detached PTY daemon (`daemon-entry.js` on `~/.config/orca/daemon/daemon-v21.sock`) and the whole agent process tree (zsh → claude) ran on uninterrupted — confirmed by PIDs/etime across the restart.
- The daemon did **not** idle-shutdown at any point while live PTYs existed (observed over ~10 min of serve downtime and after).
- The new runtime re-listed the terminal under the **same handle**.

What did not:

- `terminal read` on the pre-restart terminal returned an **empty tail forever** after restart; `terminal send` and even a direct write to the PTY slave produced no observable output. A fresh terminal in the same worktree read/wrote fine, isolating the fault to pre-restart PTYs.
- The old web client did not reconnect (its pairing token died with the old serve instance — "Could not connect to the remote Orca runtime" banner; its frozen screen is a stale local buffer, not live state).
- A **freshly paired** web client showed the workspace **without the Claude terminal tab at all**; `terminal switch` to the surviving handle was accepted but never rendered the pane.
- The Claude TUI froze at the kill frame ("Warping…", tool at 58 s / 30 ticks) and never reacted to Escape or new prompts. Likely mechanism: with no client draining the PTY master after the old runtime died, backpressure wedged the TUI mid-turn (unproven — all observation paths to that PTY were broken, which is the point).

Operational consequence: after a serve restart, a pre-restart agent session is **orphaned, not resumed** — alive (and consuming its API session) but unobservable and undriveable until killed. Two follow-ups for the build-posture decision:

1. Treat an `orca serve` restart like the already-accepted hard-reboot case: **re-dispatch the ticket, don't expect resume.** The architecture (escalation contract, session-identity decision) already tolerates exactly this.
2. curia's daemon needs an **orphan sweep** on reconcile: after a serve restart, kill agent processes whose terminals no longer bind, or they leak RAM and API sessions silently.

Does this reopen the Paseo/herdr comparison (the ticket's stated trigger)? Argued no: the deciding hard filter was concurrent multi-client attach + detach-survival, which passed (claim 1; ordinary client detach was unaffected). No candidate survives a daemon restart mid-turn — Paseo and herdr lose the turn too (herdr's `--resume` recovers to last checkpoint, arguably a small edge). Orca loses its *claimed* extra advantage but keeps every advantage that decided the eval. Final call belongs to the build-posture ticket.

## Claim 3 — Headless resource footprint: measured

| Component | RSS |
|---|---|
| `orca serve` Electron tree + PTY daemon (9 processes, idle) | ~1.0 GB total (~2% of one core) |
| — of which detached PTY daemon | ~110 MB |
| Per worker: shell | ~10 MB |
| Per worker: Claude Code process | ~350–400 MB |
| Per worker: Codex process | ~320 MB |
| Xvfb (not measured — estimate for true headless) | +50–100 MB |

RSS double-counts shared pages across the Electron tree, so true unique memory is somewhat lower. Rule of thumb for Hetzner sizing: **~1 GB base + ~0.4 GB per live worker**. An 8 GB box (CX32/CPX31) comfortably runs serve + a handful of parallel workers; 4 GB would be tight.

## Claim 4 — Non-Claude worker spawn: PASS

`orca worktree create --agent codex --prompt "…"` spawned Codex v0.145.0 (gpt-5.5) in a fresh worktree; it booted, answered the prompt, and was waitable (`tui-idle`) and readable through the identical terminal API as the Claude worker. The model-routing rule's GPT lane works as designed.

## Incidental findings

- `orca serve` on this build prints the runtime endpoint, pairing code, and web client URL as one JSON line — easy for a dispatcher to parse.
- Claude Code inside an Orca worktree starts at the folder-trust prompt; automated dispatch must answer it (or pre-trust paths) before the first prompt lands.
- Web-client pairing tokens are per-serve-instance: every restart mints a new pairing URL, so phone/browser bookmarks break on restart — a bridge/dispatcher should re-publish the fresh URL (e.g. to Discord) after any restart.
- `terminal read` returns a screen-diff-style tail that is often empty/partial for TUI redraws; polling it for agent state is unreliable — `terminal wait --for tui-idle` is the dependable primitive.
