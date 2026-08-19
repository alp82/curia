// PROTOTYPE (#542) — throwaway driver for the pane-rewind probes.
// Thin CLI over daemon/src/tmux.mjs so every keystroke the probe sends rides
// the daemon's own paced write path (PANE_WRITE_GAP_MS, per-pane queue).
// Usage:
//   node drive.mjs new  <session> <cwd> <env.json> <shell command...>
//   node drive.mjs text <session> <literal text>   # text + Enter, one job
//   node drive.mjs key  <session> <tmux key name>  # Escape, Enter, Up, Down...
//   node drive.mjs cap  <session>                  # pane text to stdout
//   node drive.mjs kill <session>

import fs from 'node:fs'
import { newSession, sendText, sendKey, capturePane, killSession } from '../../daemon/src/tmux.mjs'

const [, , cmd, name, ...rest] = process.argv

if (cmd === 'new') {
  const [cwd, envFile, ...shell] = rest
  const env = JSON.parse(fs.readFileSync(envFile, 'utf8'))
  await newSession({ name, cwd, env, shellCmd: shell.join(' '), exitMarker: 'probe' })
} else if (cmd === 'text') {
  await sendText(name, rest.join(' '))
} else if (cmd === 'key') {
  await sendKey(name, rest[0])
} else if (cmd === 'cap') {
  process.stdout.write(await capturePane(name))
} else if (cmd === 'kill') {
  await killSession(name)
} else {
  console.error('unknown command', cmd)
  process.exit(1)
}
