// The GitHub card of integration setup (#875, filling the #874 seam under
// the #852 contract and the #853 journey).
//
// One verifier, and it answers the frame's one question: is GitHub connected
// on THIS read? The manifest flow that creates the App is `GitHubAppSetup`
// (#694), already routed and already landing the converted App in
// `secrets/github-app.json` under a root (#867); this module adds nothing to
// it. What #852 asks the card to prove, after the App exists and the operator
// installed it on github.com, is two facts:
//
//   1. the installation covers at least one WATCHED repository, and
//   2. curia can mint the installation credential its agents run on.
//
// Both are measured, never remembered. Every read re-reads the installations
// (an install is an act between polls), mints one real WRITE token per
// installed owner (the agents' set; a fresh mint is proof of the grant in a
// way a cached one is not), asks that installation what it covers, and reads
// the open tickets of the covered repositories on that same token. The token
// is dropped when the read ends: it reaches no file, no log, and no answer.
//
// THE ZERO IS HONEST (#853). A covered repository with a `ready-for-agent`
// ticket connects the card on that real ticket. One without connects it on
// the repository, the count of open tickets, and what the minted credential
// grants — never a fabricated ticket.
//
// THE EXPECTED STATES ARE STEPS, NOT FAILURES (#891). The card is a guide
// of three steps, and `detail.step` names the one the operator is at:
// `create` (no App yet), `install` (the App exists and no installation
// covers a repository yet), `watch` (installations cover repositories and
// nothing is watched yet). Each of those is `{ unconnected }` with the
// detail, which the frame draws plain, because on a fresh installation they
// are what the operator meets on the way and none of them is wrong. A
// failed verification is a real failure only: GitHub refused the App, a
// mint failed, the installation can't be read, or a watched repository lost
// its coverage. The rehearsal pressed Try again on the expected states and
// read a red card every time; the guide replaces that.
//
// THE OPERATOR CHOOSES WHAT TO WATCH HERE (#891). A fresh installation has no
// watched repository (#866 writes none, and the shipped watch list stays with
// the source deployment), so the card reads what every installation covers
// and hands the list on as `detail.available`; the panel offers it with a
// checkbox per repository and writes the choice into `config/config.yaml`
// through the settings save. ONE covered watched repository connects the
// card. An owner on the watch list with no installation is a fact the detail
// carries (`owners[].installed`), and it is called missing only when no
// watched owner is installed at all.
//
// THE OPERATOR'S OWN AUTHORIZATION IS PROVED HERE TOO (#891, ADR-0031). The
// gate approval is posted as the operator, on the token GitHub handed the
// App when the operator installed it (githuboperator.mjs). So once an
// installation exists the card asks that token who it stands for, reports
// the login as a fact (`detail.operator.login`), and fails, at the install
// step, when curia holds none or GitHub refuses it: the cure is to reinstall
// the App from the panel's link, which repeats the authorization. The source
// deployment wires no operator and keeps its host login, so the card says
// nothing about it there.

import { api, WRITE_PERMISSIONS, installUrlFor, listInstallationRepos, mintInstallationToken } from './githubapp.mjs'

// What each permission of the minted credential is called on the card.
const CAPABILITY_NAMES = Object.freeze({
  issues: 'Issues', pull_requests: 'pull requests', contents: 'contents', statuses: 'commit statuses',
})

// The label the dispatch loop takes work from (docs/agents/triage-labels.md).
export const READY_LABEL = 'ready-for-agent'

const ownerOf = (repo) => String(repo).split('/')[0]

function list(items, word = 'or') {
  if (items.length <= 1) return items.join('')
  if (items.length === 2) return `${items[0]} ${word} ${items[1]}`
  return `${items.slice(0, -1).join(', ')}, ${word} ${items[items.length - 1]}`
}

// The one page of open issues the card reads per covered repository. Pull
// requests share the number space and are dropped; a ticket is discovered
// when it carries the ready label and nobody holds it yet.
async function readTickets(repo, { token, fetchImpl }) {
  const payload = await api(`/repos/${repo}/issues?state=open&per_page=100`, { jwt: token, fetchImpl })
  const open = (payload ?? []).filter((i) => i && !i.pull_request)
  const ready = open.find((i) =>
    (i.labels ?? []).some((l) => (typeof l === 'string' ? l : l?.name) === READY_LABEL)
    && !(i.assignees ?? []).length)
  return {
    open: open.length,
    ticket: ready ? { repo, number: ready.number, title: String(ready.title ?? ''), url: ready.html_url ?? null } : null,
  }
}

// `minter` and `watch` are read on every call rather than held: the App is
// adopted in process when the manifest flow completes, and the watch list
// changes on a settings save, and the card has to see both without a restart.
export function githubVerifier({ minter, watch, operator = () => null, fetchImpl = globalThis.fetch }) {
  return async function verifyGitHub() {
    const app = minter()
    if (!app) return { ok: false, unconnected: true, detail: { step: 'create' } }

    const watched = watch().map((w) => w.repo)
    const owners = [...new Set(watched.map(ownerOf))]

    // The App's own facts name the install link the panel draws. A failed
    // read there is not a failed verification: the link falls back to
    // GitHub's installations page.
    let facts = null
    try {
      facts = await app.readFacts()
    } catch {
      facts = null
    }
    const install_url = installUrlFor({ slug: facts?.slug ?? null })

    let installs
    try {
      installs = await app.refreshInstallations()
    } catch (e) {
      return {
        ok: false,
        failed: e.message,
        action: 'Check the App on its GitHub settings page and this host\'s clock, then try again.',
      }
    }
    const installedOn = new Set(installs.map((i) => String(i.owner ?? '').toLowerCase()))
    const ownerRows = owners.map((owner) => ({ owner, installed: installedOn.has(owner.toLowerCase()) }))
    const detail = { step: 'install', owners: ownerRows, covered: [], watched, available: [], install_url }
    const watchedOwners = new Set(owners.map((o) => o.toLowerCase()))

    // One real mint per installation, then that installation's own grant. A
    // watched owner's refusal is the failed verification; an installation on
    // an owner nobody watches yet only fails to add its repositories to the
    // choice, because nothing the card proves depends on it.
    const tokens = new Map()
    for (const install of installs) {
      const owner = String(install.owner ?? '')
      const isWatched = watchedOwners.has(owner.toLowerCase())
      let minted
      try {
        minted = await mintInstallationToken(install.id, { jwt: app.jwt(), permissions: WRITE_PERMISSIONS, fetchImpl })
      } catch (e) {
        if (!isWatched) continue
        return {
          ok: false,
          failed: `curia could not mint an installation token for ${owner}: ${e.message}`,
          action: `Accept the App's permissions on the ${owner} installation on GitHub, then try again.`,
          detail,
        }
      }
      let granted
      try {
        granted = await listInstallationRepos({ token: minted.token, fetchImpl })
      } catch (e) {
        if (!isWatched) continue
        return {
          ok: false,
          failed: `curia could not read what the App installation on ${owner} covers: ${e.message}`,
          action: 'Check the installation on GitHub, then try again.',
          detail,
        }
      }
      detail.available.push(...granted)
      const lowered = new Set(granted.map((r) => r.toLowerCase()))
      for (const repo of watched) {
        if (ownerOf(repo).toLowerCase() === owner.toLowerCase() && lowered.has(repo.toLowerCase())) detail.covered.push(repo)
      }
      tokens.set(owner.toLowerCase(), minted)
    }

    // The operator's authorization, once an installation exists to have
    // produced it. Asked before the watch step so a callback that never
    // landed is met right after the install, and before the tickets so a
    // token GitHub refuses reads nothing.
    const auth = installs.length ? operator() : null
    if (auth) {
      try {
        detail.operator = await auth.verify()
      } catch (e) {
        return {
          ok: false,
          failed: e.message,
          action: 'Reinstall the App from the link in this panel, which authorizes curia as you again, then try again.',
          detail,
        }
      }
    }

    if (detail.available.length) detail.step = 'watch'
    // Nothing watched yet is the fresh installation on its way: the install
    // step until an installation covers a repository, the choice after.
    if (!watched.length) return { ok: false, unconnected: true, detail }
    const missing = ownerRows.filter((o) => !o.installed).map((o) => o.owner)
    if (missing.length === owners.length) {
      return {
        ok: false,
        failed: `curia's GitHub App is not installed on ${list(missing)}`,
        action: `Install the App on ${missing[0]} from the link in this panel and grant it ${watched.find((r) => ownerOf(r) === missing[0])}, then try again.`,
        detail,
      }
    }
    if (!detail.covered.length) {
      const owner = ownerRows.find((o) => o.installed).owner
      const wanted = watched.filter((r) => ownerOf(r) === owner)
      return {
        ok: false,
        failed: `The App installation on ${owner} doesn't cover ${list(wanted)}`,
        action: `Grant the App access to ${wanted[0]} on the ${owner} installation on GitHub, then try again.`,
        detail,
      }
    }

    // The tickets, on the same credential. The first ready ticket in watch
    // order is the one the card shows; the count is every open ticket of
    // every covered repository.
    let open = 0
    let ticket = null
    for (const repo of detail.covered) {
      let read
      try {
        read = await readTickets(repo, { token: tokens.get(ownerOf(repo).toLowerCase()).token, fetchImpl })
      } catch (e) {
        return {
          ok: false,
          failed: `curia could not read the tickets of ${repo}: ${e.message}`,
          action: 'Check that the App installation still grants Issues on that repository, then try again.',
          detail,
        }
      }
      open += read.open
      if (!ticket && read.ticket) ticket = read.ticket
    }
    const first = tokens.get(ownerOf(detail.covered[0]).toLowerCase())
    const capabilities = Object.keys(CAPABILITY_NAMES).filter((k) => first.permissions?.[k]).map((k) => CAPABILITY_NAMES[k])
    const ready = `${list(capabilities, 'and')} ready${detail.operator?.login ? ` · approvals as ${detail.operator.login}` : ''}`
    const tickets = `${open} open ticket${open === 1 ? '' : 's'}`
    const repoLine = detail.covered.length > 1 ? `${detail.covered[0]} + ${detail.covered.length - 1} more` : detail.covered[0]
    Object.assign(detail, { step: 'done', open_tickets: open, ticket })
    if (ticket) {
      return { ok: true, emoji: '🎫', primary: `#${ticket.number} · ${ticket.title}`, secondary: `${READY_LABEL} · ${ticket.repo} · ${tickets}`, detail }
    }
    return {
      ok: true,
      emoji: '📦',
      primary: repoLine,
      secondary: `${open ? `${tickets}, none ready for an agent` : 'No open tickets'} · ${ready}`,
      detail,
    }
  }
}
