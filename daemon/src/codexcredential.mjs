// The clock the server stamped on a Codex access token, in epoch milliseconds.
//
// The token is a JSON Web Token, so both values are claims in its payload,
// read without verification. Curia isn't the audience. It only needs the two
// numbers that decide whether the credential can start work.
export function codexTokenClock(authJson) {
  try {
    const token = JSON.parse(authJson)?.tokens?.access_token
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'))
    return {
      iat: Number.isFinite(payload.iat) ? payload.iat * 1000 : null,
      exp: Number.isFinite(payload.exp) ? payload.exp * 1000 : null,
    }
  } catch {
    return { iat: null, exp: null }
  }
}

// Null on any parse failure. An unreadable credential proves nothing about
// whether a dispatch may proceed.
export function codexAccessTokenExpiry(authJson) {
  return codexTokenClock(authJson).exp
}

// The claim OpenAI stamps the subscription facts under. Read off the pinned
// codex binary (`strings codex | grep api.openai.com/auth`, codex-cli 0.151.0),
// which reads the same two fields.
const AUTH_CLAIM = 'https://api.openai.com/auth'

// The safe identity facts integration setup records (#878): the opaque account
// id and the plan the subscription is on, beside the two clock claims. NOT the
// email in the profile claim, which is a person, and never a token. Every
// field is null when the credential cannot be read, for the reason the expiry
// is: an unreadable credential proves nothing.
export function codexTokenIdentity(authJson) {
  const clock = codexTokenClock(authJson)
  let account = null
  let plan = null
  try {
    const data = JSON.parse(authJson)
    const token = data?.tokens?.access_token
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'))
    const auth = payload?.[AUTH_CLAIM] ?? {}
    const id = data?.tokens?.account_id ?? auth.chatgpt_account_id
    account = typeof id === 'string' && id ? id : null
    plan = typeof auth.chatgpt_plan_type === 'string' && auth.chatgpt_plan_type ? auth.chatgpt_plan_type : null
  } catch {
    // answered below as nulls
  }
  return { account_id: account, plan_type: plan, iat: clock.iat, exp: clock.exp }
}
