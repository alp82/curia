const RELEASE_PREFIX = Object.freeze({
  patch: 'fix',
  minor: 'feat',
  major: 'feat!',
})

// Every ordinary Curia change becomes a SemVer release candidate. Release
// Please uses its own conventional title for the generated release pull
// request, which must pass the same repository check.
const CHANGE_TITLE = /^(?:fix|feat)(?:\([a-z0-9][a-z0-9._/-]*\))?!?: \S.+$/u
const RELEASE_TITLE = /^chore\(main\): release (?:curia-daemon )?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u

export const RELEASE_LEVELS = Object.freeze(Object.keys(RELEASE_PREFIX))

export function pullRequestTitle(title, reference, releaseLevel = null) {
  const base = `${title} (${reference})`
  if (releaseLevel == null) return base
  const prefix = RELEASE_PREFIX[releaseLevel]
  if (!prefix) throw new Error(`unknown release level: ${releaseLevel}`)
  return `${prefix}: ${base}`
}

export function validReleasePullRequestTitle(title) {
  return CHANGE_TITLE.test(title) || RELEASE_TITLE.test(title)
}

export function releaseTitleHelp() {
  return [
    'Pull request titles must start with `fix:` for a patch, `feat:` for a minor release,',
    'or `feat!:` for a major release. Curia release pull requests are also accepted.',
  ].join(' ')
}
