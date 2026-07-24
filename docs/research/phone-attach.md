# Spike: browser-terminal phone attach on the lean substrate

Resolves [#32](https://github.com/alp82/curia/issues/32) — does a ttyd-style browser terminal at a stable Tailscale Serve URL, fronting a lean PTY substrate, deliver a first-class phone attach — good enough that curia never needs Orca's app/served-URL surface? Run 2026-07-24 on Alp's desktop (same Hetzner stand-in as #19/#24/#25/#29), phone test live by Alp. Spike code: [`spikes/phone-attach/`](../../spikes/phone-attach/).

## Verdict

**Pass — the composed stack (tmux + ttyd + Tailscale Serve) delivers the phone attach.** Every pass-bar item was exercised; the one real gap found (no Esc/Tab/Ctrl on phone keyboards) was closed in-spike with a ~40-line custom ttyd index adding a touch key-bar. Orca stays benched; [Pick the substrate (#30)](https://github.com/alp82/curia/issues/30) is now unblocked and decides on ops qualities alone.

## Stack

- **tmux** holds the worker session running a live Claude Code TUI — the durable thing; everything else can die.
- **ttyd 1.7.7** (single static binary, ~700 KB page, zero install) serves the terminal on `127.0.0.1:7681`, writable (`-W`); each browser client runs its own `tmux attach`, so all clients share one PTY.
- **Tailscale Serve** exposes it tailnet-only at the stable HTTPS URL `https://alppc.<tailnet>.ts.net:8443/` (needed a one-click tailnet enablement first).

## Pass bar results

| Item | Result |
|---|---|
| (a) stable-URL attach, streaming, scrollback | **PASS** — phone attached at the Serve URL; full TUI renders, scrollback by touch |
| (b) reply + slash command into the real TUI | **PASS** — typed replies and slash commands (`/model`, `/status`) worked; full panel fidelity |
| (c) keyboard-mic dictation | **PASS** — Gboard mic dictates into the composer; keyboard-level, so no secure-context/mic-permission issue |
| (d) concurrent second client, tmux interleave | **PASS** — phone + desktop browser + `tmux send-keys` all interleave into one composer, visible live everywhere, no lock |
| (e) detach/reattach + daemon restart | **PASS** — ttyd killed/restarted: session, worker, scrollback, even half-typed composer text intact; browser reattaches on reload |
| (f) responsive on modest hardware | **PASS with caveat** — initial verdict "usable with friction"; the named friction (no Esc key) was fixed by the key-bar, after which the verdict was "perfect". Tested phone was a Pixel 8 Pro — the "older phone" qualifier was not strictly exercised. Server side is featherweight (tmux + one ttyd process) |

## The one real finding: phones have no Esc

Mobile keyboards carry no Esc/Tab/Ctrl — fatal for a TUI where Esc interrupts/closes and Shift+Tab cycles modes. Fixed in-spike: ttyd's `--index` flag takes a custom page, so [`inject-keybar.py`](../../spikes/phone-attach/inject-keybar.py) patches the stock single-file index with a touch key row (Esc · Tab · ⇧Tab · ↑ · ↓ · ^C · ⏎) that

- dispatches synthetic `keydown`s into xterm.js (verified consumed — synthetic Escape closed a live `/status` panel),
- `preventDefault`s pointerdown so the terminal never loses focus and the phone keyboard stays open,
- tracks `visualViewport` so the bar rides above the virtual keyboard (offset clamped ≥ 0 — negative transient offsets are routine on Android),
- hides itself on fine-pointer (desktop) clients.

Reviewed (two-wave): anchored last-occurrence injection (global replace could corrupt the minified bundle), `touch-action: manipulation` against double-tap zoom, class-based tap feedback since `preventDefault` kills `:active`.

## Operational notes for the PoC build

- **run.sh restart-safety**: `tmux new-session -A -d` is *not* detach-safe when the session exists (becomes a blocking/failing attach) — use a `has-session` guard. Found by review, verified live.
- **Serve config flaked once**: the serve rule vanished after the initial enablement dance and had to be re-applied (`tailscale serve --bg --https=8443 http://127.0.0.1:7681`). The daemon's reconcile should assert the serve rule, same as the preview-port registry posture (#8).
- **Security is tailnet-membership only**: ttyd `-W` with no auth; ttyd ignores Tailscale identity headers, and does no Origin check on its WebSocket (a same-host webpage could inject keystrokes). Spike-accepted; production needs basic-auth or an identity-enforcing proxy in front. Feeds the #30/#31 hardening list.
- **tmux size clamp**: with mixed-size clients, tmux 3.x `window-size latest` means the most recently active client wins — the phone attach reflows the desktop view. Observed, tolerated; per-client windows exist if it ever grates.
- First-spawn folder-trust dialog (#19/#29's standing item) was answered *from the browser* — the browser lane handles worker-boot dialogs fine.

## What this means for #30

The lean composed stack now covers every surface Orca was shortlisted for: multi-device attach (browser URL from any device incl. phone), restart hygiene (tmux survives ttyd/daemon death), dictation (keyboard mic), footprint (KB-scale vs Orca's ~1 GB Electron+Xvfb base). The substrate pick reduces to herdr-vs-bare-tmux-vs-Paseo on ops qualities — driving is already substrate-independent (#29), and the phone surface is settled here.
