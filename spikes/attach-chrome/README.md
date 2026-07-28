# Prototype: what the shared browser terminal should look like

Ticket: [#69](https://github.com/alp82/curia/issues/69). **Three variants of the
attach page, switchable via `?variant=`, on the real attach URL** — the real
ttyd, the real `curia-attach.sh` whitelist, the real Tailscale Serve rule.

Throwaway. The winner gets rewritten as asserted config, not promoted as-is.

## Run

```sh
./run.sh          # build the index, make a demo session, restart ttyd with -I, print URLs
./run.sh --stop   # stock ttyd back on :7681, demo session gone
```

Judge on a real phone **and** a real desktop over the tailnet. A desktop browser
resized narrow is how the last spike's "perfect" verdict survived a missing Esc key.

## Three defects found, none of them a shape question

Every variant carries these as baseline:

1. **ttyd defaults to `rendererType: "webgl"`, which draws nothing in Firefox.**
   The attach surface is *blank* there. Reported from the PC and reproduced
   here against the **stock** ttyd index, so it is ttyd's default and not this
   chrome. The diagnostic strip showed the socket open, three frames received,
   the grid sized 174×105, the theme applied, and zero console errors — the
   renderer simply never paints. `-t rendererType=dom` and
   `-t rendererType=canvas` both render. `dom` is also the accessible one: real
   DOM text, so selection and screen readers work.
2. **ttyd 1.7.7 ships no `<meta name="viewport">`.** A phone lays the page out at
   ~980 CSS px and scales it down, so a 13px font lands at about 5px of real
   screen. This is the "even worse on mobile" half of the complaint.
3. **ttyd's default is `fontSize: 13`.** That is the desktop half. Spike #32 set
   15 and that flag never carried over.

Defect 1 matters most: it breaks the destination's "the PC attaches to the same
live session" leg on the browser this PC actually uses, and no variant would
have exposed it, because all three looked identical — blank.

## Diagnosing it

`?diag=1` shows a strip with the user agent, viewport, grid size, canvas box,
WebSocket event log and any window errors. `build-index.py` installs the socket
hook in `<head>`, ahead of ttyd's bundle, because that is the only point at
which the app's own WebSocket can be observed.

Two traps if you re-run this: headless screenshots fire on the `load` event,
which is *before* the socket connects, so a blank image proves nothing. Delay
`load` with a slow `<img>`, never a slow `<link rel=stylesheet>` — a stylesheet
in `<head>` blocks script execution too, so ttyd's own bundle does not start
either.

## What the page can already do, which changes the answer

ttyd exposes the xterm terminal as `window.term` and hangs its own
`window.term.fit()` on it. So font, line height, theme and contrast are all
live-settable from the page — no reload, no reconnect. ttyd also parses **any**
xterm option out of the URL query (`?arg=curia-69&fontSize=20`). Both are
routes the real answer can take.

## The variants

| | Stance | Chrome | Phone | Desktop |
|---|---|---|---|---|
| **A — Fit** | Readability floor first. Columns land where they land. | none (key-bar on touch only) | 15px, ~26 cols | font scales with viewport, 15–24px |
| **B — Read / Drive** | Watching and typing are different jobs. | top bar with a mode toggle | Read never opens the keyboard | same two modes |
| **C — Cockpit** | The human knows the device better than a media query. | puck, bottom right | font/keys/theme, stored per device | key-bar offered too |

- **A** is the minimal answer: fix the two defects, size by rule, show nothing else.
- **B** answers "reading versus driving" by making it a mode. Read mode sets the
  helper textarea `readonly` + `inputmode=none`, so tapping the terminal on a
  phone scrolls instead of raising the keyboard.
- **C** answers accessibility literally: font control, three themes including a
  high-contrast one at `minimumContrastRatio: 7`, 44px tap targets,
  `:focus-visible` rings, and it persists to `localStorage`.

The key-bar (Esc · Tab · ⇧Tab · ↑ · ↓ · ^C · ⏎) is spike #32's, unchanged. Each
variant only decides **when** it appears.

## Known rough edges (prototype-grade, on purpose)

- The switcher pill and the key-bar both sit at the bottom. They stack, and on a
  narrow phone that is two rows of chrome. Real chrome would only be one.
- Variant B's Read mode does not put tmux into copy-mode, so touch-scrolling
  reads xterm's own scrollback, not tmux's.
- Multiple attached clients of different sizes still reflow each other — tmux
  `window-size latest`. Nothing here changes that, and it may be a separate
  finding once a phone and a desktop are attached at once.
