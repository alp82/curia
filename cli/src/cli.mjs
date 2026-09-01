import { EXIT, Refusal } from './exit.mjs'
import { commands as lifecycleCommands, packageVersion } from './commands.mjs'
import { installationRoot } from './root.mjs'

// The lifecycle interface's one entry point. `bin/curia.mjs` calls it with the
// process's argv, env, and streams and exits with what it returns. Tests call
// it with their own, hand in a `uid` to stand in for another operator, and can
// hand in a `commands` table to observe how the core treats a command that
// throws.
export async function runCli({ argv, env, stdout, stderr, uid = process.getuid(), commands = lifecycleCommands }) {
  const [name, ...args] = argv

  if (name === undefined) {
    stderr.write(usage(commands))
    return EXIT.usage
  }
  if (name === '--version' || name === '-V') {
    stdout.write(`curia ${packageVersion}\n`)
    return EXIT.ok
  }
  if (name === 'help' || name === '--help' || name === '-h') {
    stdout.write(usage(commands))
    return EXIT.ok
  }

  const command = commands[name]
  if (!command) {
    stderr.write(`curia: unknown command: ${name}\nRun 'curia help' for the command vocabulary.\n`)
    return EXIT.usage
  }

  // No command takes an option yet. An option it does not know is a usage error
  // before anything runs, never something a stub swallows.
  const options = args.filter((a) => a.startsWith('-'))
  if (options.length > 0) {
    stderr.write(`curia ${name}: unknown option: ${options[0]}\nRun 'curia help' for the command vocabulary.\n`)
    return EXIT.usage
  }

  try {
    return await command.run({ env, args, stdout, stderr, uid, root: installationRoot(env) })
  } catch (e) {
    stderr.write(`curia ${name}: ${e.message}\n`)
    return e instanceof Refusal ? EXIT.refused : EXIT.failed
  }
}

export function usage(commands = lifecycleCommands) {
  const width = Math.max(...Object.keys(commands).map((n) => n.length))
  const lines = Object.entries(commands).map(([n, c]) => `  ${n.padEnd(width)}  ${c.summary}`)
  return [
    'usage: curia <command>',
    '',
    'Commands:',
    ...lines,
    `  ${'help'.padEnd(width)}  Print this text.`,
    '',
    'Exit codes:',
    `  ${EXIT.ok}  ok       The command did what it said.`,
    `  ${EXIT.failed}  failed   The operation started and failed. The message says what to do next.`,
    `  ${EXIT.usage}  usage    The command line was wrong. Nothing ran.`,
    `  ${EXIT.refused}  refused  Curia refused to start. Nothing changed. The message names the condition.`,
    '',
    'The installation root comes from CURIA_ROOT, which the installed launcher sets.',
    '',
  ].join('\n')
}
