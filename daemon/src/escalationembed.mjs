// The escalation message, composed once (#891).
//
// The bridge posts every question, gate, and confirm as one text message with
// the answer components under it. The Test run's panel shows the operator the
// same message as a Discord-style embed, so a human step on the run is
// unmistakable and the preview is the message the bridge posted, never a
// paraphrase. Both readers call THIS function: the bridge sends `text`, and the
// panel draws `title`, `description`, `fields`, and `footer`. The text is the
// embed's parts in order, so the two cannot disagree.
//
// What is NOT here: the buttons and the select menu. They are discord.js
// components the bridge builds, and the panel has its own answer controls that
// go through the daemon's `/answer`, the route the bridge uses.

import path from 'node:path'
import { REVIEW_KIND } from './lifecycle.mjs'
import { CONFIRM_KIND } from './reduction.mjs'
import { MAP_CLOSE_VERB } from './github.mjs'
import { smallPrint } from './messaging.mjs'

// The option bands (#431, ADR-0025). Two to four options are buttons, five to
// twenty-five ride one select menu, and past that the numbered list stays:
//  - buttons are what a phone answers fastest, and a row holds five, one of
//    which a choice card never needs;
//  - a menu carries twenty-five, and the operator wants no more than that on a
//    card: past 25 the list has stopped being a choice a human makes by
//    reading it;
//  - past 25 the numbered list stays. It is the surface of last resort, and it
//    loses nothing, which a menu that silently dropped option 26 would.
export const MAX_BUTTON_OPTIONS = 4
export const MAX_SELECT_OPTIONS = 25

// One select option shows a 100-char label and a 100-char description under it.
// An option longer than the label spills its tail into the description, so 200
// chars ride the menu whole. Past that the menu clips, and the body keeps the
// numbered list beside it. An option never loses its words to this component.
export const SELECT_LABEL = 100
export const SELECT_DESC = 100

// Whether the menu can carry this list at all, and whether it can carry it
// unclipped. Two separate questions: the first picks the component, the second
// picks whether the numbered list stays under it.
export const selectFits = (options) => options.length > MAX_BUTTON_OPTIONS
  && options.length <= MAX_SELECT_OPTIONS
export const selectClips = (options) => options.some((o) => String(o).length > SELECT_LABEL + SELECT_DESC)

const KIND_WORDS = {
  [REVIEW_KIND]: 'Review gate',
  [CONFIRM_KIND]: 'Confirm',
  'free-text': 'Question',
  choice: 'Choice',
  'approve-reject': 'Approve or reject',
  'preview-review': 'Preview review',
}

// The path a reply file lands in, as one small-print line (#712).
const replyFilesLine = (record, dataDir) =>
  `A reply here may carry files. They land under \`${path.join(dataDir ?? '', 'attachments', record.id)}/\` and reach the agent as paths.`

// The embed. `text` is what the bridge sends, byte for byte what it sent
// before this module existed; the other keys are that text taken apart the
// way Discord's own embed would show it.
export function escalationEmbed(record, { files = [], dataDir = null } = {}) {
  const who = record.ticket != null && record.ticket !== '' ? `#${record.ticket}` : String(record.agent ?? '')
  const title = `${KIND_WORDS[record.kind] ?? 'Question'} · ${who}`
  const fields = []
  const footer = []
  const parts = []
  let description

  if (record.kind === CONFIRM_KIND) {
    // Every confirm but one is about a live agent and lapses with it. The
    // empty-map verdict (#698) is about a map, so it lapses with nothing and
    // waits (including across a restart), and its footer must not promise an
    // expiry it does not have.
    description = `❓ ${record.prompt}`
    footer.push(record.action?.verb === MAP_CLOSE_VERB
      ? '✅ closes the map, and ❌ leaves it open. This question waits until you answer it.'
      : '✅ executes, and ❌ declines. This confirm lapses when its agent exits.')
    footer.push(record.id)
    parts.push(description, ...footer.map(smallPrint))
    return { id: record.id, kind: record.kind, author: 'curia', title, description, fields, footer: footer.join('\n'), text: parts.join('\n') }
  }

  if (record.kind === REVIEW_KIND) {
    // The review gate (#54) is the one kind whose prompt is a multi-line block
    // the daemon composed: summary, proposed charting, the links to look at. A
    // blockquote would mark only its first line, so it is printed as it stands.
    description = record.prompt
    const how = [
      '✅ Approve to merge and resolve. A reply is a rejection, and I take your words as the change list.',
      '🔎 Cross-check answers neither. It starts a reviewer on the other provider, and I wait for its verdict.',
    ]
    fields.push({ name: 'How to answer', value: how.join('\n') })
    footer.push(replyFilesLine(record, dataDir), record.id)
    parts.push(description, '', ...how.map((l) => `_${l}_`), ...footer.map(smallPrint))
    return { id: record.id, kind: record.kind, author: 'curia', title, description, fields, footer: footer.join('\n'), text: parts.join('\n') }
  }

  // No blockquote (#95's markdown standard): the prompt stands on its own line.
  //
  // A TYPED card (#418) puts a blank line under the head instead, because its
  // prompt is the composed card-4 body: a bold headline, the options with
  // their consequences, an optional visual and an optional spoiler. The
  // daemon composed that text with card.mjs and stored it on the record, so
  // this prints it as it stands. The bridge renders and never interprets
  // (ADR-0002), and the parts below are the ANSWER surface, not the question.
  const typed = Boolean(record.payload)
  description = /^\s*❓/.test(record.prompt) ? record.prompt : `❓ ${record.prompt}`
  parts.push(description)
  if (files.length) {
    const line = `Attached files: ${files.map((file) => `\`${file.attachment}\``).join(', ')}. Reply files return to this conversation as readable paths.`
    fields.push({ name: 'Attached files', value: line })
    parts.push(smallPrint(line))
  }
  const how = []
  if (record.kind === 'choice' && typed) {
    // The typed body already carries every option with its cost, so the
    // numbered list would say the whole card twice. Only the instruction is
    // owed, and which one depends on what component the list earns (#431).
    const labels = record.options ?? []
    if (!selectFits(labels) && labels.length > MAX_BUTTON_OPTIONS) how.push('Reply in this thread with a letter or a number.')
    else if (selectFits(labels) && selectClips(labels)) how.push('Pick from the menu below, or reply with a letter.')
    else if (selectFits(labels)) how.push('Pick from the menu below.')
  } else if (record.kind === 'choice' && (record.options ?? []).length > MAX_BUTTON_OPTIONS) {
    // The numbered list is now the FALLBACK, not the surface (#431). It is
    // printed in the two cases the menu cannot serve: a list past the menu's
    // reach, and a list whose options are too long for the menu to show
    // whole. Otherwise the menu carries every option and the list would say
    // the same thing twice, which is what makes this card scroll on a phone.
    const numbered = record.options.map((o, i) => `**${i + 1}.** ${o}`).join('\n')
    if (!selectFits(record.options)) {
      fields.push({ name: 'Options', value: numbered })
      parts.push(numbered)
      how.push('Reply in this thread with a number.')
    } else if (selectClips(record.options)) {
      fields.push({ name: 'Options', value: numbered })
      parts.push(numbered)
      how.push('Pick from the menu below, or reply with a number.')
    } else {
      how.push('Pick from the menu below.')
    }
  } else if (record.kind === 'free-text') {
    // A round says what the tap means and what a partial reply does (#285).
    // The second sentence is the load-bearing one: a question you do not
    // answer is NOT taken as recommended, it comes back in the next round.
    how.push(record.recommended
      ? '✅ takes every recommendation above. Reply in this thread to name exceptions. Unanswered questions return in the next round.'
      : 'Reply in this thread to answer.')
  } else if (record.kind === 'preview-review') {
    fields.push({ name: 'Preview', value: String(record.preview_url ?? '') })
    parts.push(`Preview: ${record.preview_url}`)
    how.push('Approve/Reject, or reply in this thread with comments.')
  }
  if (how.length) {
    fields.push({ name: 'How to answer', value: how.join('\n') })
    parts.push(...how.map((l) => `_${l}_`))
  }
  // Every card names the file path (#712, ADR-0025): one small-print line
  // says a reply may carry files, and where they land. The directory is the
  // one `#downloadAttachments` writes and the one a browser reply writes, so
  // the agent reads one shape whichever surface answered.
  footer.push(replyFilesLine(record, dataDir))
  parts.push(smallPrint(footer[0]))
  // A flagged send (#416, ADR-0005): the agent used up its three rejections
  // and curia sent the text as it stands. The operator sees which rule it
  // broke, beside the text that broke it. A flagged question still reaches
  // them, so this is a mark on the card and never a failure to ask.
  if (record.lint_flags?.length) {
    const lines = [`⚠️ curia sent this after ${record.lint_flags.length} lint fault(s) the agent did not fix:`, ...record.lint_flags]
    fields.push({ name: 'Sent with lint faults', value: lines.join('\n') })
    parts.push(smallPrint(lines.join('\n')))
  }
  footer.push(record.id)
  parts.push(smallPrint(record.id))
  return { id: record.id, kind: record.kind, author: 'curia', title, description, fields, footer: footer.join('\n'), text: parts.join('\n') }
}
