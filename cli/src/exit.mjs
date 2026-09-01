// The four exit codes every lifecycle command and the launcher use.
//
//   ok       the command did what it said.
//   failed   the command started the operation and the operation failed.
//            The installation may have changed. The message says what to do next.
//   usage    the command line was wrong. Nothing ran.
//   refused  Curia refused to start the operation. Nothing changed. The message
//            names the condition and one corrective action.
//
// A script can branch on these numbers. The launcher exits `refused` when the
// active version is incomplete, so the same code means the same thing whether
// the refusal came from the shell script or from the lifecycle interface.
export const EXIT = Object.freeze({ ok: 0, failed: 1, usage: 2, refused: 3 })

// A refusal a command raises before it changes anything. `runCli` turns it into
// `EXIT.refused` and prints the message on stderr, so a command states the
// condition once and never touches the exit code itself.
export class Refusal extends Error {
  constructor(message) {
    super(message)
    this.name = 'Refusal'
  }
}
