// Run the real entry point without credentials, network calls, or a Claude process.
import { registerHooks, syncBuiltinESMExports } from 'node:module'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'

const entry = new URL('../../bin/curia-overseer-pane.mjs', import.meta.url).href
const replacements = new Map([
  ['../src/config.mjs', `export const loadCuriaConfig = () => ({
    dispatch: { workspace_root: process.env.CURIA_TEST_ROOT }, watch: [],
    paths: { overseerTokens: process.env.CURIA_TEST_ROOT, overseerRepos: process.env.CURIA_TEST_ROOT },
  })`],
  ['../src/checkouts.mjs', 'export const syncCheckouts = async () => []'],
  ['../src/overseercreds.mjs', 'export const installCredentialConfig = async () => {}'],
])
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === entry && replacements.has(specifier)) {
      return { url: `data:text/javascript,${encodeURIComponent(replacements.get(specifier))}`, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})
childProcess.spawn = (binary, args, options) => {
  fs.writeFileSync(process.env.CURIA_TEST_CAPTURE, JSON.stringify({ binary, args, cwd: options.cwd,
    configDir: options.env.CLAUDE_CONFIG_DIR, toolSearch: options.env.ENABLE_TOOL_SEARCH }))
  const child = new EventEmitter()
  queueMicrotask(() => child.emit('exit', 0))
  return child
}
syncBuiltinESMExports()
