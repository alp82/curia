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
    why: 'The screenshot shows the whole failure. Both fences render as literal backticks, the font falls back to proportional, and the columns lose the alignment that made it a table. The seam between the two messages sits between esc-130 and esc-131. Cap the block and link the rest instead of leaning on the chunker. #432 built that cap at 1000 chars per block, and it also taught the chunker to close a fence at a split and reopen it, so a block that still slips through renders as two code blocks rather than raw backticks.',
    how: 'live',
    code: 'daemon/src/messaging.mjs — chunkMessage(), CHUNK_LIMIT = 1600, CODE_BLOCK_LIMIT = 1000; both daemon/src/bridge.mjs send paths use it',
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
    code: 'daemon/src/attachments.mjs — resolveOutboundFiles(); daemon/src/index.mjs — outboundFiles()',
  },
  {
    group: 'Attachments',
    name: 'Absolute path from inside a container',
    verdict: 'keep',
    label: 'KEEP — both path forms work',
    what: 'The same image, named by the absolute path the agent itself sees.',
    source: `#414, before the fix:
  images: ["/workspace/.../image-probe.png"]
    -> refused: not a readable path inside
       this agent's workspace

#492, on the deployed daemon:
  images: ["/workspace/.../image-probe.png"]
    -> ok, and the image rendered in the thread`,
    why: 'The daemon resolved the path against its own host view of the worktree. A containerized agent calls that same directory `/workspace`, so its absolute path matched nothing and the file was dropped. The tool text said "local file paths inside your workspace", which pointed the agent straight at the failing form. #429 taught the daemon to map an absolute `/workspace` path to its host root before it checks containment. #492 re-checked that live: the same file, by the same absolute path that #414 saw refused, passed the gate and reached the thread. The daemon returns a bare `ok` only when it refuses nothing, so the tool result is the proof that the path resolved, and the screenshot on the attachments entry below is the proof that the file arrived. The map never widened: a traversal or a symlink out is still refused.',
    how: 'live — re-checked in #492 on the deployed daemon',
    code: 'daemon/src/attachments.mjs — containedIn(), fromGuest(); daemon/src/index.mjs — outboundFiles() supplies the guestRoot',
  },
  {
    group: 'Attachments',
    name: 'Text attachments (.patch, .diff, .md, .txt, .log)',
    verdict: 'keep',
    label: 'KEEP — Discord previews a diff by name',
    what: 'A diff or a note attached to a message. Discord draws an inline preview above the file row, and it highlights a diff as a diff.',
    image: 'IMAGE:attachment-preview.png',
    source: `#414, before the allowlist widened:
  sample.patch: refused - not an image
    (allowed: .png, .jpg, .jpeg, .gif, .webp)

#492, on the deployed daemon:
  images: [".../sample.patch", ".../sample.diff"]
    -> ok, both previewed inline`,
    why: 'A #414 call refused both files, and the refusal named the extension, so the allowlist was the only blocker. #430 widened it to `.patch`, `.diff`, `.md`, `.txt` and `.log` beside the five image types, under a 1 MB cap. #492 re-checked it live, and the screenshot is the operator\'s. Discord previews both extensions, and it treats them identically, so `.diff` is no second-class name. The preview shows about the first six lines with a chevron that expands the rest, and it syntax-highlights the diff grammar: the `@@` hunk header, the `---` and `+++` lines, the added and removed rows. Under the preview sits a file row with the name, a rounded size and buttons for raw view, expand and more. This is the affordance a review gate wants. A reader judges the shape of a change without leaving the thread, and the whole file is one tap away. Two limits the preview sets: it is a HEAD, so the first lines must carry the point, and the size is rounded up, so a 264-byte patch reads as 1 KB.',
    how: 'live — re-checked in #492 on the deployed daemon',
    code: 'daemon/src/attachments.mjs — TEXT_MIME_BY_EXT, attachmentMimeFor(), MAX_TEXT_BYTES',
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
