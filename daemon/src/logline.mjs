// What journalctl will show of a daemon log line (#190).
//
// journalctl hides a whole message rather than a bad byte: `shall_print` calls
// `utf8_is_printable`, and ONE control code point anywhere in the message
// renders the entire line `[NNNB blob data]`. Control means C0 except tab and
// newline, plus DEL and C1 (U+007F-U+009F). Valid UTF-8 above that is
// printable, so an em dash costs nothing and the daemon's prose keeps the
// punctuation its writing rules ask for.
//
// The daemon streams `docker build` straight into its log, and that stream
// carries both kinds: ANSI color from the builder, and carriage-return
// progress redraws from apt. During the first containerized dispatch (#185)
// that took 64 lines dark, including the tail of a build the operator reads
// only when a build FAILS.
//
// Applied at the one `log()` every module is handed, so a control code from a
// source nobody has streamed yet costs no line either.
//
// Every code point here is named by number on purpose: a file about invisible
// characters must not contain any.

const ESC = String.fromCharCode(0x1b)
const BEL = String.fromCharCode(0x07)

// CSI (`ESC [ ... final`), OSC (`ESC ] ... BEL`, or `ESC ] ... ESC \`), and the
// two-character Fe escapes. Dropped rather than escaped: color is decoration
// and the words are the point.
const ANSI = new RegExp(
  `${ESC}(?:\\[[0-?]*[ -/]*[@-~]|\\][\\s\\S]*?(?:${BEL}|${ESC}\\\\)|[@-Z\\\\-_])`,
  'g',
)

function isControl(cp) {
  if (cp === 0x09 || cp === 0x0a) return false // tab and newline print
  return cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)
}

// The guarantee: whatever goes in, journalctl prints the words.
export function readable(text) {
  const stripped = String(text).replace(ANSI, '')
  return [...stripped].filter((ch) => !isControl(ch.codePointAt(0))).join('')
}

// A carriage return is a redraw, so keep what the terminal would have left on
// screen. `apt` writes twenty frames of `(Reading database ... N%` into one
// line. The last frame states the result and the other nineteen state nothing.
//
// This runs at the STREAM, not at `log()`: by the time a line reaches the log
// it carries a `[image <session>]` prefix, and the prefix belongs to the first
// frame — collapsing there would throw away the words that say whose build it
// is. readable() only strips the carriage returns, which is enough to print
// but not enough to read.
export function lastFrame(line) {
  const frames = line.split('\r')
  if (frames.length === 1) return line
  const drawn = frames.filter((f) => f !== '')
  return drawn.length ? drawn[drawn.length - 1] : ''
}
