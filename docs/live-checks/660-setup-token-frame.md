# 660: where `claude setup-token` puts the token, and what wraps it

Run on 2026-08-24 from a dev session. Two apparatuses, and **neither minted a credential**: the
workstation run was abandoned at the paste prompt, and the box was read rather than driven. No live
agent was touched, no daemon restarted, and `curia-652`, `curia-207` and `curia-625` were up
throughout.

#659 left this slice with one question and called it unmeasured in as many words: *"the token's own
stream at completion — the flow was abandoned at the paste prompt, so that the token lands there
among the frames is inference."* Completing the flow costs a real year-long credential and a human at
a browser. The measurements below answer the question **without** completing it, by reading the
renderer instead of the render.

## 1. The success screen, out of the box's own image

`docker run --rm --entrypoint sh curia-agent:2.1.220-0.146.0-7cba0f7a`, grepping the bundled CLI at
`/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe`. Claude Code 2.1.220 — the
version the fleet actually runs, not the workstation's 2.1.241.

The `setup-token` success state renders, verbatim from the bundle:

```js
Po.jsx(h,{color:"success",children:"✓ Long-lived authentication token created successfully!"}),
Po.jsxs(k,{flexDirection:"column",gap:1,children:[
  Po.jsx(h,{children:"Your OAuth token (valid for 1 year):"}),
  Po.jsx(h,{color:"warning",children:b.token}),
  Po.jsx(h,{dimColor:!0,children:"Store this token securely. You won't be able to see it again."}),
  Po.jsx(h,{dimColor:!0,children:"Use this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=<token>"})
]})
```

**Settled. The token is printed, and it is printed alone.** `b.token` is a bare Ink `Text`, its own
child of a `flexDirection: "column"` box with no border and no padding of its own. `gap: 1` puts a
blank line between every child, so the token has a blank line above it and a blank line below it, and
nothing shares its line.

**Settled. The two lines under it cannot be mistaken for it.** Both contain spaces, and the last one
holds the literal string `<token>` rather than the value.

**Settled, and it confirms an assumption #648 had to make.** 2.1.220 states the lifetime as the
literal string `"valid for 1 year"`. The anthropic contract's `ANTHROPIC_DOCUMENTED_LIFETIME_MS` is
one year applied to the adoption instant, and the CLI says the same number on screen. (2.1.241
computes it from an `expiresAt` instead — the string is version-specific, the year is not.)

## 2. The wrap, measured on a real pane

`claude setup-token` in a 60-column detached tmux pane on the workstation, `CLAUDE_CONFIG_DIR` on a
scratch dir, no browser opened, abandoned at the paste prompt. `tmux capture-pane -p`:

```
 Browser didn't open? Use the url below to sign  (c to copy)
 in

https://claude.com/cai/oauth/authorize?code=true&client_id=9
d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redir
ect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fc
allback&scope=user%3Ainference&code_challenge=gBwSYcCCQjC9xU
Dnje4H0Limz_8WGf6LWi9KonM8CDU&code_challenge_method=S256&sta
te=9oq-pmO4pEY1t4nD2prvbnqYYqlSkptF03z3EABHPaA

 Paste code here if prompted >
```

**Settled. Ink wraps its own text, and `capture-pane -J` cannot undo it.** Five pieces of exactly 60
characters and a short sixth. `-J` is documented to join wrapped lines and returned the **identical**
six, because these are real newlines the application emitted, not soft wraps the terminal applied.
#659 recorded this as "line-wrapped by the terminal", which is the one correction this check makes to
that record — the distinction matters, because it rules out the one-flag fix.

**Settled. The frame survives the process.** The capture above was taken after the CLI had exited;
the TUI does not use the alternate screen buffer and does not clear on exit. `newSession`'s trailing
`exec bash` keeps the pane alive, so a login that finishes between two 60-second ticks is still there
to be read on the next one.

**Settled. There is no flag that prints the token alone.** `claude setup-token --help` lists `-h`
and nothing else, on both versions.

## 3. The token's own size

`awk` over `daemon/.env.daemon` on the box, length only — the value was never printed.

```
len=108 prefix=sk-ant-oat01-
```

**Settled. 108 characters.** So it wraps on every pane narrower than itself and does not on a wide
one, and both cases have to work: pinning the pane width would fix the parse and wreck the operator's
view on a phone.

## 4. What was NOT measured, and what stands in for it

- **A frame from a login that actually completed.** Still not measured, and this record does not
  pretend otherwise. What changed is that the layout is now read out of the renderer rather than
  guessed at, and the residual risk is carried by a check rather than by hope: `SetupTokenLane` asks
  Anthropic whether the string it reassembled authenticates, and adopts only on a `200`. A misread
  frame ends the login as `failed` with the store untouched.
- **The daemon's real dispatch path.** The tmux run was by hand on the workstation, not by
  `ReauthFlow` on the box. The end-to-end live check is the follow-up, and it is the one thing here
  that needs an operator and a real credential.
- **Whether the authorize URL's shape is stable.** One sample. The reassembled URL is parsed and
  checked for `code_challenge` and `state` before the card offers it, so a change degrades to "open
  the terminal" rather than to a link that fails after the operator has followed it.
- **A pane narrow enough to scroll the token out of view.** `capture-pane` reads the visible pane. A
  very short pane with a long frame could push the token above the top; not observed, not ruled out.
