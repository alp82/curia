// Curia's release identity lives in daemon/package.json. Git refs still drive
// the deploy and rollback mechanics, but operators see this version instead
// of a commit hash.

import fs from 'node:fs'

export const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export function parseAppVersion(packageJson, source = 'daemon/package.json') {
  let manifest
  try {
    manifest = JSON.parse(packageJson)
  } catch (e) {
    throw new Error(`${source} is not valid JSON: ${e.message}`)
  }
  const version = manifest?.version
  if (typeof version !== 'string' || !SEMVER_RE.test(version)) {
    throw new Error(`${source} must contain a semantic version, got ${JSON.stringify(version)}`)
  }
  return version
}

function identifiers(version) {
  const match = SEMVER_RE.exec(version)
  return {
    core: match.slice(1, 4),
    pre: match[4] == null ? null : match[4].split('.'),
  }
}

function compareNumeric(left, right) {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1
  return left === right ? 0 : (left < right ? -1 : 1)
}

export function compareAppVersions(left, right) {
  const a = identifiers(left)
  const b = identifiers(right)
  for (let i = 0; i < a.core.length; i += 1) {
    const order = compareNumeric(a.core[i], b.core[i])
    if (order) return order
  }
  if (a.pre == null || b.pre == null) return a.pre == null ? (b.pre == null ? 0 : 1) : -1
  const length = Math.max(a.pre.length, b.pre.length)
  for (let i = 0; i < length; i += 1) {
    if (a.pre[i] == null || b.pre[i] == null) return a.pre[i] == null ? -1 : 1
    if (a.pre[i] === b.pre[i]) continue
    const aNumber = /^\d+$/.test(a.pre[i])
    const bNumber = /^\d+$/.test(b.pre[i])
    if (aNumber && bNumber) return compareNumeric(a.pre[i], b.pre[i])
    if (aNumber !== bNumber) return aNumber ? -1 : 1
    return a.pre[i] < b.pre[i] ? -1 : 1
  }
  return 0
}

export const APP_VERSION = parseAppVersion(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
)
