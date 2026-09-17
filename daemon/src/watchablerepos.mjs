// Repository discovery uses the same installation grants as dispatch. Only
// source deployments without an App retain the legacy host-login reader.
export class WatchableRepos {
  constructor({ minter, legacy = null, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
    Object.assign(this, { minter, legacy, now, sleep })
    this.cached = null
    this.pending = null
  }

  async read({ refresh = false } = {}) {
    if (this.pending) return this.pending
    if (!refresh && this.cached && this.now() - this.cached.at < 600_000) return this.cached.value
    this.pending = this.fetch().finally(() => { this.pending = null })
    return this.pending
  }

  async fetch() {
    const app = this.minter()
    let value
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (app) {
          const installations = await app.refreshInstallations()
          const repos = []
          for (const installation of installations) repos.push(...await app.reposFor(installation.owner))
          value = { source: 'installation', login: null, repos: [...new Set(repos)].sort(), error: null }
        } else if (this.legacy) {
          value = { ...await this.legacy(), source: 'host', error: null }
        } else {
          return { source: 'installation', repos: null, error: 'Connect the GitHub App to load repositories.', recovery: 'setup', stale: false }
        }
        value.read_at = new Date(this.now()).toISOString()
        this.cached = { at: this.now(), value }
        return value
      } catch (error) {
        const transient = error.status >= 500 || ['TypeError', 'TimeoutError', 'AbortError'].includes(error.name)
        if (transient && attempt < 2) {
          await this.sleep(250 * 2 ** attempt)
          continue
        }
        // Keep the last successful list, but never cache a failed read.
        return {
          ...(this.cached?.value ?? { source: app ? 'installation' : 'host', login: null, repos: null }),
          error: error.status === 429 ? 'GitHub is limiting requests. Try again later.'
            : transient ? 'GitHub is temporarily unavailable. Try again.'
            : 'Curia could not read repository access. Check the GitHub connection in Setup.',
          recovery: transient || error.status === 429 ? 'retry' : 'setup',
          stale: Boolean(this.cached),
        }
      }
    }
  }
}
