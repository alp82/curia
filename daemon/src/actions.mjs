const TERMINAL = new Set(['confirmed', 'refused', 'failed'])

export class ActionCoordinator {
  constructor(reduction, { log = () => {} } = {}) {
    this.reduction = reduction
    this.log = log
    this.running = new Map()
  }

  get(actionId) {
    return this.reduction.action(actionId)
  }

  overview() {
    return this.reduction.actionsOnWire()
  }

  confirm(actionId, detail = {}) {
    const current = this.get(actionId)
    if (!current || TERMINAL.has(current.status)) return current
    return this.reduction.recordAction({ ...current, ...detail, status: 'confirmed' })
  }

  settled(actionId) {
    const running = this.running.get(String(actionId))
    if (running) return running.settled
    const evidence = this.get(actionId)
    return TERMINAL.has(evidence?.status) ? Promise.resolve(evidence) : Promise.resolve(null)
  }

  async run(action, work) {
    const actionId = String(action?.action_id ?? '')
    if (!actionId) throw new Error('an Action needs an action_id')
    const recorded = this.get(actionId)
    if (recorded) return recorded
    if (this.running.has(actionId)) return this.running.get(actionId).first

    let release
    const first = new Promise((resolve) => { release = resolve })
    let accepted = false
    const write = (status, detail = {}) => {
      const evidence = this.reduction.recordAction({ ...action, ...detail, status })
      if (!accepted && status === 'accepted') accepted = true
      release(evidence)
      return evidence
    }
    const controls = {
      accept: (detail = {}) => write('accepted', detail),
      progress: (progress, detail = {}) => {
        if (!accepted) throw new Error('Action progress cannot precede acceptance')
        return write('progress', { ...detail, progress })
      },
    }

    const settled = Promise.resolve()
      .then(() => work(controls))
      .then((out = {}) => {
        const current = this.get(actionId)
        if (TERMINAL.has(current?.status)) {
          release(current)
          return current
        }
        if (accepted) {
          if (out.status === 'accepted' || out.status === 'progress') return current
          const status = out.status === 'failed' ? 'failed' : 'confirmed'
          return write(status, out)
        }
        const status = ['confirmed', 'refused', 'failed'].includes(out.status) ? out.status : 'refused'
        return write(status, out)
      })
      .catch((error) => {
        const current = this.get(actionId)
        return TERMINAL.has(current?.status)
          ? current
          : write(accepted ? 'failed' : 'refused', { reason: error.message })
      })
      .finally(() => this.running.delete(actionId))

    this.running.set(actionId, { first, settled })
    settled.catch((error) => this.log(`Action ${actionId} failed to settle: ${error.message}`))
    return first
  }
}
