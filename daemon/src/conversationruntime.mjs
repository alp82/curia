// Shared pane behavior for agent and overseer conversations. Role policy stays
// with each caller. This module owns only message rewind and correction rules.

import { readActiveTranscript } from './transcript.mjs'
import { capturePane, paneShowsActiveTurn, sendKey, sendText } from './tmux.mjs'

const defaultPane = {
  active: async (session) => paneShowsActiveTurn(await capturePane(session)),
  key: sendKey,
  text: sendText,
}

const oneLine = (text, max = 80) => {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

function operatorTurns(read) {
  return read.records
    .map((record) => ({
      ...record,
      prompt: record.items.find((item) => item.kind === 'prompt') ?? null,
    }))
    .filter((record) => record.prompt?.text?.trim())
}

export class ConversationRuntime {
  constructor({ pane = defaultPane, reduction, reopenCard = null, prepare = async () => {} }) {
    this.pane = pane
    this.reduction = reduction
    this.reopenCard = reopenCard
    this.prepare = prepare
  }

  async takeBack({ session, role, harness, source, landing = null, target: requestedTarget = null }) {
    if (requestedTarget?.kind === 'note') return this.#takeBackNote({ session, role, target: requestedTarget })
    if (requestedTarget?.kind === 'answer') return this.#takeBackAnswer({ session, role, target: requestedTarget })
    const read = readActiveTranscript(harness, source, {
      landingUuid: landing?.uuid ?? null,
      landingTailUuid: landing?.tailUuid ?? null,
    })
    if (read.failures.length) throw new Error(`the active transcript cannot be rewound: ${read.failures[0]}`)
    const turns = operatorTurns(read)
    if (turns.length < 2) {
      const error = new Error('the first message starts the conversation and cannot be taken back')
      error.status = 409
      throw error
    }
    const target = turns.at(-1)
    const previous = turns.at(-2)
    await this.prepare(session, role)
    if (await this.pane.active(session)) await this.pane.key(session, 'Escape')
    await this.#rewind(session, harness)

    if (harness === 'claude' && target.parentUuid) {
      this.reduction.journal('transcript_landed', {
        session,
        landing_uuid: target.parentUuid,
        tail_uuid: read.headUuid,
      })
    }
    const requeued = this.reduction.takeBackConversationTurn?.(session, target.prompt.text) ?? []
    const receipt = {
      headline: 'Took back your last message.',
      landing: `The conversation continues after “${oneLine(previous.prompt.text)}”`,
      remains: harness === 'claude'
        ? [
            'Files restored with the conversation.',
            'Shell side effects, Curia verbs, subagent edits, and commits stand.',
          ]
        : [
            'The tree stands. Only the conversation rewound.',
            'Shell side effects, Curia verbs, subagent edits, and commits stand.',
          ],
    }
    if (requeued.length) {
      receipt.remains.push(`Returned ${requeued.length} unread note${requeued.length === 1 ? '' : 's'} to the queue.`)
    }
    this.reduction.journal('conversation_message_taken_back', {
      session,
      role,
      harness,
      text: target.prompt.text,
      landing_uuid: harness === 'claude' ? target.parentUuid : null,
      transcript_tail_uuid: read.headUuid ?? null,
      receipt,
    })
    return { ok: true, composer: target.prompt.text, receipt }
  }

  async correct({ session, role, correction, text }) {
    const words = String(text ?? '')
    if (!words.trim()) {
      const error = new Error('a correction needs text')
      error.status = 400
      throw error
    }
    if (!correction?.prefix) {
      const error = new Error('the correction target is missing')
      error.status = 409
      throw error
    }
    const framed = `${correction.prefix}\n${words}`
    await this.prepare(session, role)
    const delivery = await this.pane.text(session, framed)
    if (delivery?.status === 'not-sent') {
      const error = new Error('the pane stayed active, so Curia did not send the correction')
      error.status = 409
      throw error
    }
    this.recordTurn({ session, role, text: framed })
    this.reduction.journal('conversation_correction_sent', {
      session, role, delivery: correction.kind, target: correction.id, text: words,
    })
    return { ok: true }
  }

  recordTurn({ session, text }) {
    return this.reduction.recordConversationTurn?.(session, text) ?? null
  }

  async #takeBackNote({ session, role, target }) {
    const note = this.reduction.noteById?.(target.id)
    if (!note || note.agent !== session) {
      const error = new Error('that note does not belong to this conversation')
      error.status = 404
      throw error
    }
    if (!note.pending) {
      await this.prepare(session, role)
      if (await this.pane.active(session)) await this.pane.key(session, 'Escape')
      const correction = { kind: 'note', id: note.id, prefix: 'Correction to the note above:' }
      const receipt = {
        headline: 'Started a correction for your note.',
        landing: 'The conversation did not rewind.',
        remains: ['The note and all later work stand.'],
      }
      this.reduction.journal('conversation_correction_started', {
        session, role, delivery: 'read_note', note: note.id, text: note.text, receipt,
      })
      return { ok: true, composer: note.text, correction, receipt }
    }
    this.reduction.takeBackAgentNote(target.id)
    const receipt = {
      headline: 'Took back your unread note.',
      landing: 'The conversation did not change.',
      remains: ['Nothing reached the conversation.', 'World state did not change.'],
    }
    this.reduction.journal('conversation_message_taken_back', {
      session,
      role,
      delivery: 'unread_note',
      note: note.id,
      text: note.text,
      receipt,
    })
    return { ok: true, composer: note.text, correction: null, receipt }
  }

  async #takeBackAnswer({ session, role, target }) {
    const record = this.reduction.get?.(target.id)
    if (!record || record.agent !== session) {
      const error = new Error('that answer does not belong to this conversation')
      error.status = 404
      throw error
    }
    if (record.status !== 'answered') {
      const error = new Error('that card has no answer to correct')
      error.status = 409
      throw error
    }
    if (!this.reopenCard) throw new Error('card correction is not configured')
    await this.prepare(session, role)
    if (await this.pane.active(session)) await this.pane.key(session, 'Escape')
    const fresh = await this.reopenCard(record)
    const correction = {
      kind: 'answer', id: record.id, card: fresh.id, prefix: 'Correction to the answer above:',
    }
    if (fresh.answered) {
      fresh.answered
        .then(({ text }) => this.correct({ session, role, correction, text }))
        .catch((error) => this.reduction.journal('conversation_correction_failed', {
          session, role, delivery: 'card_answer', card: record.id,
          correction_card: fresh.id, error: error.message,
        }))
    }
    const receipt = {
      headline: 'Started a correction for your answer.',
      landing: 'The conversation did not rewind.',
      remains: ['The answer and all later work stand.'],
    }
    this.reduction.journal('conversation_correction_started', {
      session, role, delivery: 'card_answer', card: record.id, correction_card: fresh.id,
      text: record.answer, receipt,
    })
    return { ok: true, composer: record.answer, correction, receipt }
  }

  async #rewind(session, harness) {
    if (harness === 'claude') {
      for (const key of ['Escape', 'Escape', 'Up', 'Enter', 'Enter', 'C-c']) {
        await this.pane.key(session, key)
      }
      return
    }
    if (harness === 'codex') {
      for (const key of ['Escape', 'Escape', 'Enter', 'C-u']) {
        await this.pane.key(session, key)
      }
      return
    }
    throw new Error(`the ${harness} harness has no checked rewind flow`)
  }
}
