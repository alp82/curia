// Credential failures without a stable provider code get a short, bounded
// retry window. Both provider paths use the dispatch tick's one-minute clock.
export const TRANSIENT_RETRY_BOUND = 5
export const CREDENTIAL_RETRY_MS = 60 * 1000
