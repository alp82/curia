// Recovery for an existing GitHub App. Only the daemon handles credentials.
// The browser receives a GitHub URL and presence flags; the callback is bound
// to the tailnet identity that started it, with expiring state and PKCE.
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { writeAtomically } from '../../cli/src/atomic.mjs'
import { readSecret, writeSecret } from '../../cli/src/secrets.mjs'
import { APP_SECRET } from './githubapp.mjs'

export class GitHubReconnect {
  constructor({ root, authorization, now = Date.now }) {
    this.root = root
    this.authorization = authorization
    this.now = now
    this.pendingFile = path.join(root, 'run', 'github-reconnect.json')
  }

  start({ client_id, client_secret, redirect_uri, operator }) {
    const redirect = new URL(redirect_uri)
    if (redirect.protocol !== 'https:' || redirect.username || redirect.password || redirect.search || redirect.hash || redirect.pathname !== '/api/github-app/authorize') {
      throw new Error('Use this Curia installation’s HTTPS callback address.')
    }
    if (!operator) throw new Error('Open Setup from your tailnet to authorize GitHub.')
    const app = JSON.parse(readSecret(this.root, APP_SECRET) ?? 'null')
    if (!app?.id || !app?.pem) throw new Error('Create a GitHub App in Setup first.')
    if (client_id !== undefined || client_secret !== undefined) {
      if (typeof client_id !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(client_id) ||
          typeof client_secret !== 'string' || !/^[A-Za-z0-9_-]{1,255}$/.test(client_secret)) {
        throw new Error('Enter the Client ID and client secret from your GitHub App settings.')
      }
      Object.assign(app, { client_id, client_secret })
      writeSecret(this.root, APP_SECRET, `${JSON.stringify(app)}\n`)
    }
    if (!app.client_id || !app.client_secret) throw new Error('Connect your existing App using the credential form in Setup.')
    const state = randomBytes(32).toString('hex')
    const verifier = randomBytes(32).toString('base64url')
    writeAtomically(this.pendingFile, JSON.stringify({ state, verifier, operator, redirect_uri, expires_at: this.now() + 10 * 60_000 }), { mode: 0o600 })
    const url = new URL('https://github.com/login/oauth/authorize')
    url.search = new URLSearchParams({ client_id: app.client_id, redirect_uri, state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString()
    return { url: url.toString() }
  }

  async complete({ code, state, operator }) {
    let pending
    try { pending = JSON.parse(fs.readFileSync(this.pendingFile, 'utf8')) } catch { /* no pending authorization */ }
    if (!pending || !state || state !== pending.state || operator !== pending.operator || this.now() >= pending.expires_at) {
      throw new Error('This authorization link expired or belongs to another session. Select Authorize GitHub in Setup again.')
    }
    // Consume before awaiting GitHub so two callbacks cannot exchange one code.
    fs.unlinkSync(this.pendingFile)
    try {
      return await this.authorization.authorize({ code, codeVerifier: pending.verifier, redirectUri: pending.redirect_uri })
    } catch {
      throw new Error('GitHub authorization failed. Check your App credentials and callback in Setup, then authorize again.')
    }
  }
}
