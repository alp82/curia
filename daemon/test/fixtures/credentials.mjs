// The model-credential doubles every dispatch test needs (#648).
//
// A claude dispatch REFUSES without an owned anthropic credential — the same
// trade the GitHub mint makes, and for the same reason: a loud failure before
// any claim work is lost beats a silent death mid-ticket. So a working store is
// the default for every test that spawns, exactly as `workingMinter` is, and the
// tests about a box with no credential pass `null` instead.
//
// It is a DOUBLE and not the real `AnthropicCredentialStore`, because the real
// one writes a file under a real workspace root. What the dispatcher asks of it
// is `read()` and `fanOut()`, and nothing more.

// A `setup-token`-shaped value that passes `ANTHROPIC_TOKEN_RE` and reaches no
// provider.
export const TEST_ANTHROPIC_TOKEN = 'sk-ant-oat01-test-credential-0000000000'

export function workingAnthropicStore({
  token = TEST_ANTHROPIC_TOKEN, obtained_at = '2026-08-01T00:00:00.000Z',
} = {}) {
  const record = { token, obtained_at, seeded_at: null }
  return {
    record,
    read: () => record,
    fanOut: () => ({ healed: [], errors: [] }),
    state: (consumer) => ({
      consumer, provider: 'anthropic', state: 'valid', expires_at: '2027-08-01T00:00:00.000Z', why: 'a test double',
    }),
  }
}
