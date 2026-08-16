// The escalation's own render retry (#261).
//
// Until #261 a per-escalation 30-minute interval carried three jobs, and two of
// them were dead: an elapsed-time refresh the status line's own meter tick
// already does (#146), and a journal counter nothing read. The third one is
// real — an escalation whose Discord render failed (the bridge was down, #22)
// has to try again — so it survives here, alone and BOUNDED.
//
// The offsets are measured from `esc_open`, not from the failure, because the
// escalation owns the schedule: the record knows when it opened, so a daemon
// restart re-arms exactly the retries that have not passed yet instead of
// starting a fresh unbounded clock.
//
// After the last one the daemon stops trying. Nothing is lost: the record stays
// open and REST-answerable, and the dashboard reads the reduction rather than
// Discord, so it shows the question either way.
export const RENDER_RETRY_MS = [60_000, 5 * 60_000, 15 * 60_000]

// Delays from `now` for the retries still ahead of an escalation opened at
// `openedAt`. Empty means the window is over and this record never renders
// again — including a record whose `opened_at` cannot be read.
export function remainingRenderRetries(openedAt, now) {
  const opened = Date.parse(openedAt ?? '')
  if (Number.isNaN(opened)) return []
  return RENDER_RETRY_MS.map((ms) => opened + ms - now).filter((ms) => ms > 0)
}
