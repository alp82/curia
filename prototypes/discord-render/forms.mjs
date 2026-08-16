// The catalog data for ticket #414, kept beside the page that renders it.
//
// `build.mjs` inlines this array and the image probe into `index.html`, so the
// page stays one self-contained file. Edit the verdicts here, then run the
// build. Do not edit the generated block inside `index.html` by hand.
//
// verdict: keep | drop | hold ("hold" means the daemon cannot emit the form
// yet, so the verdict names the file that blocks it).
// how: "live" (posted into the #414 thread and judged on a phone) or "code".

export const FORMS = [
  {
    group: 'Text forms',
    name: 'Markdown table, no code block',
    verdict: 'drop',
    label: 'DROP',
    what: 'A plain markdown table, the shape every other tracker renders.',
    source: `| Surface | Kind | Lint grade |
|---|---|---|
| ask_human | choice | strict |
| report_result | summary | STE |
| notify | progress | STE |`,
    why: 'Discord has no table renderer. The pipes and dashes stay raw, so the reader sees punctuation instead of columns. A typed payload must never emit this shape.',
    how: 'live',
    code: 'none — plain prose through notify',
  },
  {
    group: 'Text forms',
    name: 'Code-block table',
    verdict: 'keep',
    label: 'KEEP — cap the width',
    what: 'The same table, space-aligned inside a fence. The monospace font does the aligning.',
    source: `\`\`\`
Surface        | Kind     | Lint grade
---------------|----------|-----------
ask_human      | choice   | strict
report_result  | summary  | STE
notify         | progress | STE
\`\`\``,
    why: 'This is the only table form Discord renders. A phone does not wrap a code block, it scrolls it sideways, so a wide table hides its own right edge. Keep the total width near 42 columns.',
    how: 'live',
    code: 'none — plain prose through notify',
  },
  {
    group: 'Text forms',
    name: 'ASCII diagram',
    verdict: 'keep',
    label: 'KEEP — cap the width',
    what: 'A box-and-arrow sequence diagram in a fence.',
    source: `\`\`\`
  agent                daemon              Discord
    |                    |                    |
    |--- ask_human ----->|                    |
    |                    |--- lint ---.       |
    |                    |<-----------'       |
    |                    |--- card ---------->|
\`\`\``,
    why: 'It carries a flow that prose needs a paragraph for, and it costs no attachment and no deploy. The width cap binds harder here than on a table, because a diagram loses its meaning the moment a column scrolls out of view.',
    how: 'live',
    code: 'none — plain prose through notify',
  },
  {
    group: 'Text forms',
    name: 'Spoiler tags',
    verdict: 'keep',
    label: 'KEEP — the Details affordance',
    what: 'Text hidden behind one tap, inline or as a whole block.',
    source: `Inline: the lint grade for an option is ||strict||.

||A whole block behind one tap. The daemon rejects the call and
returns the lint message. The agent rewrites its own text.||`,
    why: 'The card ticket (#415) needs a Details affordance, and this is the only one that costs no second message and no button. The detail stays in the same message as the decision, which is what keeps a card from splitting across the scroll.',
    how: 'live',
    code: 'none — plain prose through notify',
  },
  {
    group: 'Text forms',
    name: 'Small print',
    verdict: 'keep',
    label: 'KEEP — one line only',
    what: 'The meta register. Discord shrinks any line that starts with `-# `.',
    source: `This line is the normal register.
-# Source: daemon/src/messaging.mjs, smallPrint()
-# Small print marks the meta register (#89).`,
    why: 'It separates the meta register from the decision without a second voice. A phone shrinks it again on top of Discord, so two stacked small-print lines read as one mangled line. The research note already records that failure in the wild.',
    how: 'live',
    code: 'daemon/src/messaging.mjs — smallPrint()',
  },
  {
    group: 'Text forms',
    name: 'Code block past the 1600-char chunk limit',
    verdict: 'drop',
    label: 'DROP — the chunker breaks the fence',
    what: 'A 34-row table inside one fence, sent as a single notify call. The screenshot is the operator\'s, taken on a phone.',
    image: 'IMAGE:form7-broken-fence.png',
    source: `chunkMessage() splits at 1600 chars: paragraphs first,
then lines, then a hard slice. It never sees the fence.

  chunk 1 -> opens \`\`\` and never closes it
  chunk 2 -> raw rows, then a stray closing \`\`\``,
    why: 'The screenshot shows the whole failure. Both fences render as literal backticks, the font falls back to proportional, and the columns lose the alignment that made it a table. The seam between the two messages sits between esc-130 and esc-131. Cap the block and link the rest instead of leaning on the chunker.',
    how: 'live',
    code: 'daemon/src/messaging.mjs — chunkMessage(), CHUNK_LIMIT = 1600; both daemon/src/bridge.mjs send paths use it',
  },
  {
    group: 'Attachments',
    name: 'Image attachment',
    verdict: 'keep',
    label: 'KEEP',
    what: 'A PNG attached to a notify call. The probe prints one line at four pixel scales.',
    image: 'IMAGE:image-probe.png',
    source: `notify({ message: "...", images: ["prototypes/discord-render/image-probe.png"] })`,
    why: 'Discord shows an attached image inline, so a diagram reaches the reader without a tap. The operator read scale 2 and no smaller, which sets the floor: a glyph must be at least 10 pixels tall in an 800-pixel-wide image. Anything under that does not survive the phone.',
    how: 'live',
    code: 'daemon/src/images.mjs — resolveOutboundImages(); daemon/src/index.mjs — outboundImages()',
  },
  {
    group: 'Attachments',
    name: 'Absolute path from inside a container',
    verdict: 'drop',
    label: 'DROP — the path form is refused',
    what: 'The same image, named by the absolute path the agent itself sees.',
    source: `images: ["/workspace/prototypes/discord-render/image-probe.png"]
  -> refused: not a readable path inside this agent's workspace

images: ["prototypes/discord-render/image-probe.png"]
  -> ok`,
    why: 'The daemon resolves the path against its own host view of the worktree. A containerized agent calls that same directory `/workspace`, so its absolute path matches nothing and the file is dropped. The tool text says "local file paths inside your workspace", which points the agent straight at the failing form. Always send a worktree-relative path.',
    how: 'live',
    code: 'daemon/src/images.mjs — containedIn(); roots come from the agent record wtPath',
  },
  {
    group: 'Attachments',
    name: '.patch and .md attachments',
    verdict: 'hold',
    label: 'NEEDS CODE — allowlist',
    what: 'A diff or a note attached to a message, with the inline preview Discord gives a text file.',
    source: `images: ["prototypes/discord-render/sample.patch", "CONTEXT.md"]

  sample.patch: refused - not an image
    (allowed: .png, .jpg, .jpeg, .gif, .webp)
  CONTEXT.md:   refused - not an image
    (allowed: .png, .jpg, .jpeg, .gif, .webp)`,
    why: 'A live call refused both files. The refusal names the extension, so the allowlist is the only blocker and containment is not involved. The form is worth having: a diff in the thread is the one artifact a review gate cannot fit in prose. It needs the allowlist widened first, and Discord gives a text file an inline preview once it arrives.',
    how: 'live — the refusal is the result',
    code: 'daemon/src/images.mjs — MIME_BY_EXT, mimeFor()',
  },
  {
    group: 'Interactive components',
    name: 'Buttons',
    verdict: 'keep',
    label: 'KEEP — bot voice only',
    what: 'The answer affordance on an escalation card, and link buttons on a status line.',
    source: `record.kind === 'free-text' && record.recommended
  -> "All as recommended"
record.kind === 'choice' && options.length <= 23
  -> one button per option, else a numbered list`,
    why: 'Buttons are the one form that answers a question in a single tap, which is what a phone is for. They carry a hard cost: interactive components need an application-owned webhook, so any message with a button is bot-posted and loses the agent speaker identity. A card cannot have both buttons and the agent voice.',
    how: 'live',
    code: 'daemon/src/bridge.mjs — #buttons(), MAX_BUTTON_OPTIONS = 23, #webhook()',
  },
  {
    group: 'Interactive components',
    name: 'Select menus',
    verdict: 'hold',
    label: 'NEEDS CODE — not built',
    what: 'A dropdown of options, the component Discord offers above the button count.',
    source: `grep -rn "SelectMenu\\|StringSelect" daemon/src/
  -> no matches`,
    why: 'The daemon builds buttons and link buttons and nothing else. Above 23 options a choice card degrades to a numbered list and asks for a typed reply, which is the case a select menu exists to serve. The form cannot be judged live until the bridge can emit one, and no deploy runs from this ticket. The operator ruled it to one follow-up ticket that does the code and the live test together.',
    how: 'code',
    code: 'daemon/src/bridge.mjs — #buttons() builds ActionRowBuilder with ButtonBuilder only',
  },
]
