// PROTOTYPE (#570) — throwaway driver for the overseer-pane probes.
// Thin CLI over daemon/src/tmux.mjs so every keystroke the probe sends rides
// the daemon's own paced write path (PANE_WRITE_GAP_MS, per-pane queue).
// Same tool as the #542 driver, plus `paste` for a multi-line message.
// Usage:
//   node drive.mjs new   <session> <cwd> <env.json> <shell command...>
//   node drive.mjs text  <session> <literal text>   # text + Enter, one job
//   node drive.mjs key   <session> <tmux key name>  # Escape, Enter, Up, Down...
//   node drive.mjs paste <session> <file>           # bracketed paste of the file text
//   node drive.mjs cap   <session>                  # pane text to stdout
//   node drive.mjs kill  <session>

import fs from 'node:fs'
import { execFileP } from '../../daemon/src/exec.mjs'
import { newSession, sendText, sendKey, capturePane, killSession, TMUX_SOCKET } from '../../daemon/src/tmux.mjs'

const [, , cmd, name, ...rest] = process.argv

if (cmd === 'new') {
  const [cwd, envFile, ...shell] = rest
  const env = JSON.parse(fs.readFileSync(envFile, 'utf8'))
  await newSession({ name, cwd, env, shellCmd: shell.join(' '), exitMarker: 'probe' })
} else if (cmd === 'text') {
  await sendText(name, rest.join(' '))
} else if (cmd === 'key') {
  await sendKey(name, rest[0])
} else if (cmd === 'paste') {
  // The one write tmux.mjs does not have: set-buffer + paste-buffer -p delivers
  // multi-line text as a BRACKETED PASTE, so the composer keeps the newlines
  // instead of submitting on the first one. This is the candidate mechanic for
  // ADR-0023's note batch (prefixed lines riding the operator message).
  const text = fs.readFileSync(rest[0], 'utf8')
  const t = (args) => execFileP('tmux', TMUX_SOCKET ? ['-S', TMUX_SOCKET, ...args] : args, { timeout: 5000 })
  await t(['set-buffer', '-b', 'curia-probe', text])
  await t(['paste-buffer', '-p', '-b', 'curia-probe', '-t', `=${name}:`])
} else if (cmd === 'cap') {
  process.stdout.write(await capturePane(name))
} else if (cmd === 'kill') {
  await killSession(name)
} else {
  console.error('unknown command', cmd)
  process.exit(1)
}
