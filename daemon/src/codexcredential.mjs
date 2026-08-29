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
