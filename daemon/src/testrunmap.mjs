// The Test run's own map and tickets (#891).
//
// The Test run used to take the first takeable ticket carrying the `rehearsal`
// label, which made the operator write a ticket before the installation could
// be accepted. Now the press creates a tiny wayfinder map in the watched
// repository with two child tickets: the first appends one line to the README,
// the second removes it, blocked by the first through GitHub's native
// dependency. The run drives both through the Full loop and the map closes on
// Curia's own map lifecycle, so the repository is left as it was.
//
// This module is the text: titles, bodies, and labels. It reads nothing and
// writes nothing; `fullloop.mjs` lands it through the tracker.

// The label a wayfinder map carries (the dispatcher's own `MAP_LABEL`).
const MAP_LABEL = 'wayfinder:map'

export const TEST_RUN_LABEL = 'rehearsal'

// The tickets' own type (#891, the owner's decision on the rehearsal): the
// live run dispatched the acceptance on the frontier model at high effort,
// and its cross-check on the same tier. `test-run` is the routing row that
// names the cheapest model at its lowest effort, for the agent and for the
// cross-check alike (`defaults.test-run` and `review.test-run` in
// `config/routing.yaml`). The type label is FIRST in the list, because the
// router reads the first `wayfinder:` label.
export const TEST_RUN_TYPE = 'test-run'
export const TICKET_LABEL = `wayfinder:${TEST_RUN_TYPE}`

// The date the map is named after, in the unambiguous long form the operator
// guide uses (September 3, 2026).
export function testRunDate(now = new Date()) {
  return now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })
}

export const readmeLine = (date) => `Curia Test run, ${date}.`

const ASK = 'Before you change the file, ask the operator one question through your escalation tool: confirm the exact wording of the line, or offer a wording of your own. Use the answer. Then open a pull request and ask for review.'

export function testRunMap(date) {
  const title = `Test run ${date}`
  const line = readmeLine(date)
  return {
    title,
    labels: [MAP_LABEL, TEST_RUN_LABEL],
    body: [
      `# ${title}`,
      '',
      `Curia created this map when the operator started the Test run on ${date}. It proves one Full loop on this installation: two small tickets, one after the other, that leave the repository as it was.`,
      '',
      '## Notes',
      '',
      '- Ticket 1 appends one line to the bottom of `README.md`. Ticket 2 removes it again and is blocked by ticket 1.',
      `- Both tickets carry the \`${TEST_RUN_LABEL}\` label. Curia closes this map when both are closed.`,
      '',
      '## Decisions so far',
      '',
      '## Not yet specified',
      '',
    ].join('\n'),
    tickets: [
      {
        title: 'Add a line to the README',
        labels: [TICKET_LABEL, TEST_RUN_LABEL],
        body: () => [
          `Part of the map **${title}**, Curia's installation acceptance.`,
          '',
          'Append one line to the bottom of `README.md` at the repository root. Create the file if it doesn\'t exist. The line is:',
          '',
          `    ${line}`,
          '',
          ASK,
        ].join('\n'),
      },
      {
        title: 'Remove the Test run line from the README',
        labels: [TICKET_LABEL, TEST_RUN_LABEL],
        body: (first) => [
          `Part of the map **${title}**, Curia's installation acceptance. Blocked by #${first} until that ticket is merged.`,
          '',
          `Remove the line \`${line}\` from the bottom of \`README.md\`. If #${first} created the file and nothing else is in it, delete the file. Leave the rest of the file as it was.`,
          '',
          ASK,
        ].join('\n'),
      },
    ],
  }
}
