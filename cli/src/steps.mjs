import { Refusal } from './exit.mjs'

// The named steps of one lifecycle command (#873's shape, lifted for #885):
// each step is printed as `[n/N] <name>` when it begins, and an error that
// escapes a step is turned into one that names the step. A `Refusal` keeps
// its class and exit code and gains the step's name; any other error becomes
// `<step> failed: <cause>` followed by the line that says how to run the
// step again. Every command that has steps says the same things the same
// way, so an operator reads one shape.
export function namedSteps({ steps, stdout, rerun }) {
  let current = null
  return {
    begin(name) {
      current = name
      stdout.write(`[${steps.indexOf(name) + 1}/${steps.length}] ${name}\n`)
    },
    wrap(e) {
      if (current === null) return e
      if (e instanceof Refusal) return new Refusal(`${current}: ${e.message}`)
      const wrapped = new Error(`${current} failed: ${e.message}\n${rerun(current)}`)
      wrapped.cause = e
      return wrapped
    },
  }
}
