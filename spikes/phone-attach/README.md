# Spike: browser-terminal phone attach on the lean substrate

Ticket: [#32](https://github.com/alp82/curia/issues/32). Can a ttyd-style browser
terminal at a stable Tailscale Serve URL, fronting bare tmux, deliver a
first-class phone attach — so curia never needs Orca's app/served-URL surface?

## Stack

- **tmux** holds the worker session (`curia-worker`) running a live Claude Code
  TUI. The session is the durable thing; everything else can die.
- **ttyd** (static binary, v1.7.7) serves the terminal at `127.0.0.1:7681`.
  Each browser client runs its own `tmux attach`, so all clients share one PTY
  with tmux-style interleave. `-W` makes it writable.
- **Tailscale Serve** exposes it tailnet-only at a stable HTTPS URL:
  `tailscale serve --bg --https=8443 http://127.0.0.1:7681`

## Run

```sh
./run.sh /path/to/ttyd [workspace-dir]   # start tmux worker + ttyd
./run.sh --stop                          # tear down
```

## Mobile key-bar

Phone keyboards have no Esc/Tab/Ctrl — a blocker for a real TUI (Claude Code
leans on Esc). `inject-keybar.py` patches ttyd's stock index with a touch
key row (Esc · Tab · ⇧Tab · ↑ · ↓ · ^C · ⏎) that dispatches synthetic
KeyboardEvents into xterm.js, keeps terminal focus, tracks the visual
viewport so it stays above the virtual keyboard, and hides itself on
fine-pointer (desktop) clients:

```sh
curl -s http://127.0.0.1:7681/ -o index-orig.html     # grab stock page (ttyd running)
./inject-keybar.py index-orig.html index-keybar.html
# restart ttyd with: --index index-keybar.html
```

## Verified agent-side (desktop browser via CDP, 2026-07-24)

- Live Claude Code TUI renders in the browser; first-spawn folder-trust dialog
  answered *from the browser* (Enter).
- `/status` typed in the browser opens the real slash-command panel — full TUI
  fidelity, not a dumb pipe.
- Second client (`tmux send-keys`) interleaves into the same composer; the
  browser sees it live. No lock.
- ttyd killed and restarted (ttyd process restarted directly; `run.sh` now
  re-runs cleanly too — has-session guard): tmux session, worker, scrollback,
  and even uncommitted composer text all intact; browser reattaches on reload.

## Security posture (spike-grade, known gaps)

- ttyd runs `-W` (writable) with **no auth** (`-c`), and ttyd does not consume
  Tailscale Serve identity headers — the only gate is tailnet membership. Any
  tailnet device (incl. shared nodes) gets an interactive shell as this user.
- ttyd does no Origin validation: any webpage open in a browser **on the worker
  host itself** can hit `ws://127.0.0.1:7681` and inject keystrokes.
- Fine for a time-boxed spike; a real deployment needs `-c`/basic-auth or a
  fronting proxy that enforces identity, noted for the substrate pick.

## Left to the phone test (HITL)

Stable-URL attach over Tailscale from an older phone, keyboard-mic dictation,
concurrent phone+laptop attach, and responsiveness on old hardware.

Known wrinkle to watch: with multiple attached clients of different sizes,
tmux sizes the window per its `window-size` policy (3.x default `latest` —
the most recently active client wins), so a phone attach may reflow the
desktop view and vice versa.
