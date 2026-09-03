import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  SUPPORTED_SYSTEMS, MINIMUM_PROFILE, RECOMMENDED_PROFILE, TESTED_VERSIONS, REQUIRED_PORTS, SANDBOX_PORTS,
  RELEASE_ORIGINS, CHECKS,
  evaluateHostFacts, gatherHostFacts, renderPreflight, preflight,
} from '../src/preflight.mjs'
import { Refusal } from '../src/exit.mjs'

const GiB = 1024 ** 3

// A host that passes every check: Ubuntu 24.04 at the recommended profile.
function ubuntu(overrides = {}) {
  return {
    uid: 1001,
    os: { id: 'ubuntu', versionId: '24.04', prettyName: 'Ubuntu 24.04.2 LTS' },
    arch: 'x64',
    cpus: 4,
    memoryBytes: 8 * GiB,
    disk: { path: '/home/operator', freeBytes: 40 * GiB },
    ports: { busy: [], sandboxFree: 300 },
    docker: {
      client: { version: '27.5.1' },
      server: { version: '27.5.1', apiVersion: '1.47', rootless: false, serviceEnabled: true },
      socket: { path: '/var/run/docker.sock', accessible: true },
      group: { name: 'docker', gid: 988, member: true },
      probe: { mount: true, network: true },
    },
    compose: { version: '2.32.4' },
    tailscale: {
      installed: true,
      version: '1.80.2',
      daemon: { running: true, error: null },
      backendState: 'Running',
      online: true,
      certDomains: ['host.tail1234.ts.net'],
    },
    outbound: RELEASE_ORIGINS.map((origin) => ({ origin, reachable: true, certificateValid: true, skewSeconds: 2 })),
    ...overrides,
  }
}

function debian(overrides = {}) {
  return ubuntu({
    os: { id: 'debian', versionId: '13', prettyName: 'Debian GNU/Linux 13 (trixie)' },
    docker: { ...ubuntu().docker, server: { ...ubuntu().docker.server, version: '26.1.5' } },
    ...overrides,
  })
}

function check(report, name) {
  const found = report.checks.find((c) => c.name === name)
  assert.ok(found, `the report has a check named ${name}: ${report.checks.map((c) => c.name).join(', ')}`)
  return found
}

function refusedOn(report, name, observed, action) {
  const c = check(report, name)
  assert.equal(c.status, 'refused', `${name} refuses: ${c.observed}`)
  assert.match(c.observed, observed)
  assert.match(c.action, action)
  assert.equal(report.ok, false)
  assert.ok(report.refusal instanceof Refusal)
  assert.match(report.refusal.message, observed)
}

function warnedOn(report, name, observed, action) {
  const c = check(report, name)
  assert.equal(c.status, 'warning', `${name} warns: ${c.observed}`)
  assert.match(c.observed, observed)
  assert.match(c.action, action)
  assert.equal(report.ok, true, 'a warning is a nonblocking fact')
  assert.equal(report.refusal, null)
}

describe('the contract', () => {
  test('names the two supported systems, the two profiles, and the tested versions', () => {
    assert.deepEqual(SUPPORTED_SYSTEMS.map((s) => `${s.id} ${s.versionId}`), ['ubuntu 24.04', 'debian 13'])
    assert.deepEqual(MINIMUM_PROFILE, { cpus: 2, memoryBytes: 4 * GiB, freeDiskBytes: 15 * GiB })
    assert.deepEqual(RECOMMENDED_PROFILE, { cpus: 4, memoryBytes: 8 * GiB, freeDiskBytes: 30 * GiB })
    for (const tool of ['docker', 'compose', 'tailscale']) {
      assert.ok(TESTED_VERSIONS[tool].oldest && TESTED_VERSIONS[tool].newestMajor, `${tool} has a tested range`)
    }
  })

  test('the required local ports are the ones the bundle binds', () => {
    assert.deepEqual(REQUIRED_PORTS.map((p) => p.port), [4272, 4273, 4274, 7681, 7682])
    assert.deepEqual(SANDBOX_PORTS, { from: 9000, to: 9299, perAgent: 3, agents: 4 })
    for (const p of REQUIRED_PORTS) assert.ok(p.holder, `${p.port} names its holder`)
  })

  test('the release origins are the three the bootstrap and the images come from', () => {
    assert.deepEqual([...RELEASE_ORIGINS], ['https://registry.npmjs.org', 'https://github.com', 'https://ghcr.io'])
  })

  test('every check is documented with a name and a class', () => {
    assert.equal(CHECKS.length, 12)
    for (const c of CHECKS) {
      assert.ok(c.name && c.summary, `${c.name} is summarized`)
      assert.ok(['blocking', 'warning', 'mixed'].includes(c.severity), `${c.name} has a class`)
    }
  })
})

describe('a supported host passes', () => {
  test('Ubuntu 24.04 at the recommended profile passes every check with no warning', () => {
    const report = evaluateHostFacts(ubuntu())
    assert.equal(report.ok, true)
    assert.equal(report.refusal, null)
    assert.deepEqual(report.checks.map((c) => c.status), CHECKS.map(() => 'passed'))
    assert.equal(report.checks.length, CHECKS.length)
  })

  test('Debian 13 passes too', () => {
    const report = evaluateHostFacts(debian())
    assert.equal(report.ok, true)
    assert.deepEqual(report.checks.filter((c) => c.status !== 'passed'), [])
  })

  test('Docker Engine 29 passes without a version warning', () => {
    const docker = { ...ubuntu().docker, server: { ...ubuntu().docker.server, version: '29.7.0' } }
    const report = evaluateHostFacts(ubuntu({ docker }))
    assert.equal(check(report, 'Docker Engine').status, 'passed')
  })

  test('Docker Compose 5 passes without a version warning', () => {
    const report = evaluateHostFacts(ubuntu({ compose: { version: '5.5.0' } }))
    assert.equal(check(report, 'Docker Compose').status, 'passed')
  })

  test('the operating-system check reports the release it saw', () => {
    assert.match(check(evaluateHostFacts(debian()), 'operating system').observed, /Debian GNU\/Linux 13/)
  })
})

describe('refused conditions stop the operation', () => {
  test('root execution', () => {
    refusedOn(evaluateHostFacts(ubuntu({ uid: 0 })), 'operator', /runs as root/, /as the operator/)
  })

  test('another operating-system release', () => {
    const facts = ubuntu({ os: { id: 'ubuntu', versionId: '22.04', prettyName: 'Ubuntu 22.04.5 LTS' } })
    refusedOn(evaluateHostFacts(facts), 'operating system', /Ubuntu 22\.04\.5 LTS/, /Ubuntu 24\.04 LTS or Debian 13/)
  })

  test('a derivative with the same version number', () => {
    const facts = ubuntu({ os: { id: 'linuxmint', versionId: '22', prettyName: 'Linux Mint 22' } })
    refusedOn(evaluateHostFacts(facts), 'operating system', /Linux Mint 22/, /Ubuntu 24\.04 LTS or Debian 13/)
  })

  test('an unreadable os-release', () => {
    refusedOn(evaluateHostFacts(ubuntu({ os: null })), 'operating system', /could not read \/etc\/os-release/, /Ubuntu 24\.04 LTS or Debian 13/)
  })

  test('another architecture', () => {
    refusedOn(evaluateHostFacts(ubuntu({ arch: 'arm64' })), 'architecture', /arm64/, /x86-64/)
  })

  test('a required port in use', () => {
    const facts = ubuntu({ ports: { busy: [{ port: 7681, process: 'ttyd (pid 4242)' }], sandboxFree: 300 } })
    refusedOn(evaluateHostFacts(facts), 'required ports', /7681.*ttyd \(pid 4242\)/, /Stop the program/)
  })

  test('too few free sandbox ports for the default concurrency', () => {
    const facts = ubuntu({ ports: { busy: [], sandboxFree: 11 } })
    refusedOn(evaluateHostFacts(facts), 'required ports', /11 of the 300 ports .*9000.*9299/, /12/)
  })

  test('no Docker Engine', () => {
    refusedOn(evaluateHostFacts(ubuntu({ docker: null })), 'Docker Engine', /not installed/, /docs\.docker\.com/)
  })

  test('a Docker socket the operator cannot reach', () => {
    const docker = { ...ubuntu().docker, socket: { path: '/var/run/docker.sock', accessible: false }, group: { name: 'docker', gid: 988, member: false }, server: null, probe: null }
    refusedOn(evaluateHostFacts(ubuntu({ docker })), 'Docker Engine', /cannot open \/var\/run\/docker\.sock/, /usermod -aG docker/)
  })

  test('a Docker daemon that is not running', () => {
    const docker = { ...ubuntu().docker, server: null, error: 'Cannot connect to the Docker daemon', probe: null }
    refusedOn(evaluateHostFacts(ubuntu({ docker })), 'Docker Engine', /not running/, /systemctl start docker/)
  })

  test('a known-incompatible Docker Engine', () => {
    const docker = { ...ubuntu().docker, server: { ...ubuntu().docker.server, version: '19.03.15' } }
    refusedOn(evaluateHostFacts(ubuntu({ docker })), 'Docker Engine', /19\.03\.15.*known incompatible/, /24\.0/)
  })

  test('bind mounts that do not work', () => {
    const docker = { ...ubuntu().docker, probe: { mount: false, network: true, error: 'the probe read nothing from the mounted file' } }
    refusedOn(evaluateHostFacts(ubuntu({ docker })), 'Docker capabilities', /bind mount/, /Docker Engine/)
  })

  test('host networking that does not work', () => {
    const docker = { ...ubuntu().docker, probe: { mount: true, network: false, error: 'connect: connection refused' } }
    refusedOn(evaluateHostFacts(ubuntu({ docker })), 'Docker capabilities', /host network/, /Docker Engine/)
  })

  test('no Compose plugin', () => {
    refusedOn(evaluateHostFacts(ubuntu({ compose: null })), 'Docker Compose', /docker compose.*not available/, /docker-compose-v2|compose plugin/)
  })

  test('Compose v1', () => {
    refusedOn(evaluateHostFacts(ubuntu({ compose: { version: '1.29.2' } })), 'Docker Compose', /1\.29\.2/, /2\.20/)
  })

  test('no Tailscale', () => {
    refusedOn(evaluateHostFacts(ubuntu({ tailscale: null })), 'Tailscale', /not installed/, /tailscale\.com/)
  })

  test('a tailscaled that is not running', () => {
    const tailscale = { ...ubuntu().tailscale, daemon: { running: false, error: 'failed to connect to local tailscaled; it doesn\'t appear to be running' }, backendState: 'Unknown', online: false, certDomains: [] }
    refusedOn(evaluateHostFacts(ubuntu({ tailscale })), 'Tailscale', /tailscaled is not running/, /sudo systemctl start tailscaled/)
  })

  // Since #891 the login, the operator permission, and the certificate are
  // the tailnet step's, inside `curia install`: the preflight asks only for
  // the package and the daemon, because those are what Curia never installs.
  test('a Tailscale node that needs a login passes the preflight; the tailnet step logs it in', () => {
    const tailscale = { ...ubuntu().tailscale, backendState: 'NeedsLogin', online: false, certDomains: [] }
    const report = evaluateHostFacts(ubuntu({ tailscale }))
    assert.equal(report.ok, true)
    assert.equal(check(report, 'Tailscale').status, 'passed')
    assert.match(check(report, 'Tailscale').observed, /NeedsLogin/)
  })

  test('a release origin that is unreachable', () => {
    const outbound = ubuntu().outbound.map((o) => (o.origin === 'https://ghcr.io' ? { origin: o.origin, reachable: false, error: 'getaddrinfo ENOTFOUND ghcr.io' } : o))
    refusedOn(evaluateHostFacts(ubuntu({ outbound })), 'outbound access', /ghcr\.io.*ENOTFOUND/, /outbound HTTPS/)
  })

  test('a certificate the host cannot verify', () => {
    const outbound = ubuntu().outbound.map((o) => (o.origin === 'https://github.com' ? { origin: o.origin, reachable: true, certificateValid: false, error: 'unable to get local issuer certificate' } : o))
    refusedOn(evaluateHostFacts(ubuntu({ outbound })), 'release verification', /github\.com.*issuer certificate/, /ca-certificates/)
  })

  test('a clock too far from the release origins', () => {
    const outbound = ubuntu().outbound.map((o) => ({ ...o, skewSeconds: 900 }))
    refusedOn(evaluateHostFacts(ubuntu({ outbound })), 'release verification', /15 minutes/, /timedatectl set-ntp true/)
  })

  test('every refusal is listed, not only the first', () => {
    const report = evaluateHostFacts(ubuntu({ uid: 0, arch: 'arm64', compose: null }))
    assert.deepEqual(report.checks.filter((c) => c.status === 'refused').map((c) => c.name), ['operator', 'architecture', 'Docker Compose'])
    assert.match(report.refusal.message, /3 conditions/)
  })
})

describe('warnings are nonblocking facts', () => {
  test('a host below the minimum profile', () => {
    const report = evaluateHostFacts(ubuntu({ cpus: 1, memoryBytes: 2 * GiB, disk: { path: '/home/operator', freeBytes: 10 * GiB } }))
    warnedOn(report, 'host capacity', /1 CPU.*2\.0 GiB.*10\.0 GiB free/, /2 CPU cores, 4 GiB of memory, and 15 GiB of free disk/)
  })

  test('a host at the minimum but below the recommended profile', () => {
    const report = evaluateHostFacts(ubuntu({ cpus: 2, memoryBytes: 4 * GiB, disk: { path: '/', freeBytes: 15 * GiB } }))
    warnedOn(report, 'host capacity', /below the recommended profile/, /4 CPU cores, 8 GiB of memory, and 30 GiB of free disk/)
  })

  test('rootless Docker whose probes pass', () => {
    const docker = { ...ubuntu().docker, server: { ...ubuntu().docker.server, rootless: true } }
    warnedOn(evaluateHostFacts(ubuntu({ docker })), 'Docker Engine', /rootless/, /rootful/)
  })

  test('a Docker service that does not start at boot', () => {
    const docker = { ...ubuntu().docker, server: { ...ubuntu().docker.server, serviceEnabled: false } }
    warnedOn(evaluateHostFacts(ubuntu({ docker })), 'Docker Engine', /not enabled at boot/, /systemctl enable docker/)
  })

  test('a Docker Engine older than the tested range but not known incompatible', () => {
    const docker = { ...ubuntu().docker, server: { ...ubuntu().docker.server, version: '23.0.6' } }
    warnedOn(evaluateHostFacts(ubuntu({ docker })), 'Docker Engine', /23\.0\.6.*older than the oldest tested/, /24\.0/)
  })

  test('tools newer than the tested range', () => {
    const docker = { ...ubuntu().docker, server: { ...ubuntu().docker.server, version: '30.0.0' } }
    const report = evaluateHostFacts(ubuntu({ docker, compose: { version: '6.0.0' }, tailscale: { ...ubuntu().tailscale, version: '2.0.0' } }))
    warnedOn(report, 'Docker Engine', /30\.0\.0.*newer than the tested/, /watch/i)
    warnedOn(report, 'Docker Compose', /6\.0\.0.*newer than the tested/, /watch/i)
    warnedOn(report, 'Tailscale', /2\.0\.0.*newer than the tested/, /watch/i)
  })

  test('a Compose plugin older than the tested range', () => {
    warnedOn(evaluateHostFacts(ubuntu({ compose: { version: '2.17.0' } })), 'Docker Compose', /2\.17\.0.*older than the oldest tested/, /2\.20/)
  })
})

describe('the rendered report', () => {
  test('prints one line per check and the refusal last', () => {
    const text = renderPreflight(evaluateHostFacts(ubuntu({ arch: 'arm64', cpus: 1 })))
    const lines = text.trimEnd().split('\n')
    assert.match(lines[0], /^ok\s+operator/)
    assert.match(text, /^refused\s+architecture\s+.*arm64/m)
    assert.match(text, /^warning\s+host capacity/m)
    assert.match(text, /^ {2,}.*x86-64/m, 'the corrective action follows on its own indented line')
    assert.match(lines.at(-1), /refused: 1 condition/)
  })

  test('never prints a secret-shaped value', () => {
    const text = renderPreflight(evaluateHostFacts(ubuntu()))
    assert.doesNotMatch(text, /token|password|secret/i)
  })
})

// gatherHostFacts runs the probes against fake system boundaries. The
// fakes stand for the commands, files, and sockets on a supported host, and
// the tests read what the facts say about them.
function fakeProbes(overrides = {}) {
  const calls = []
  const exec = async (file, args) => {
    calls.push([file, ...args])
    const line = [file, ...args].join(' ')
    if (line === 'docker version --format json') return { ok: true, stdout: JSON.stringify({ Client: { Version: '27.5.1' }, Server: { Version: '27.5.1', ApiVersion: '1.47' } }) }
    if (line === 'docker info --format json') return { ok: true, stdout: JSON.stringify({ ServerVersion: '27.5.1', SecurityOptions: ['name=apparmor', 'name=seccomp,profile=builtin'] }) }
    if (line === 'systemctl is-enabled docker') return { ok: true, stdout: 'enabled\n' }
    if (line === 'docker compose version --short') return { ok: true, stdout: '2.32.4\n' }
    if (line === 'tailscale version') return { ok: true, stdout: '1.80.2\n  tailscale commit: abc\n' }
    if (line === 'tailscale status --json') return { ok: true, stdout: JSON.stringify({ BackendState: 'Running', Self: { Online: true }, CertDomains: ['host.tail1234.ts.net'] }) }
    if (line.startsWith('getent group docker')) return { ok: true, stdout: 'docker:x:988:operator\n' }
    if (line.startsWith('docker run ')) {
      const dir = args[args.indexOf('-v') + 1].split(':')[0]
      const url = args.at(-1).match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0]
      const token = (await import('node:fs')).readFileSync(join(dir, 'probe'), 'utf8')
      const body = url ? await (await fetch(url)).text() : 'no url'
      return { ok: true, stdout: `${token}\n${body}\n` }
    }
    if (line.startsWith('docker rm -f')) return { ok: true, stdout: '' }
    if (line.startsWith('ss ')) return { ok: true, stdout: '' }
    return { ok: false, stdout: '', stderr: `fake: no such command: ${line}`, code: 127 }
  }
  return {
    calls,
    exec,
    readFile: (path) => (path === '/etc/os-release' ? 'PRETTY_NAME="Ubuntu 24.04.2 LTS"\nNAME="Ubuntu"\nVERSION_ID="24.04"\nID=ubuntu\nID_LIKE=debian\n' : null),
    arch: () => 'x64',
    cpus: () => 4,
    memoryBytes: () => 8 * GiB,
    freeDiskBytes: () => 40 * GiB,
    socketAccessible: () => true,
    groups: () => [1001, 988],
    fetchOrigin: async (origin) => ({ origin, reachable: true, certificateValid: true, skewSeconds: 1 }),
    now: () => Date.now(),
    ...overrides,
  }
}

describe('gatherHostFacts', () => {
  test('reads a supported host into facts that pass evaluation', async () => {
    const probes = fakeProbes()
    const facts = await gatherHostFacts({ uid: 1001, root: '/home/operator/.local/share/curia' }, probes)
    assert.deepEqual(facts.os, { id: 'ubuntu', versionId: '24.04', prettyName: 'Ubuntu 24.04.2 LTS' })
    assert.equal(facts.docker.server.version, '27.5.1')
    assert.equal(facts.docker.server.rootless, false)
    assert.equal(facts.docker.server.serviceEnabled, true)
    assert.deepEqual(facts.docker.group, { name: 'docker', gid: 988, member: true })
    assert.deepEqual(facts.docker.probe, { mount: true, network: true })
    assert.equal(facts.compose.version, '2.32.4')
    assert.equal(facts.tailscale.version, '1.80.2')
    assert.deepEqual(facts.tailscale.certDomains, ['host.tail1234.ts.net'])
    assert.deepEqual(facts.tailscale.daemon, { running: true, error: null })
    assert.ok(!probes.calls.some((c) => c[0] === 'tailscale' && c[1] === 'serve'), 'the preflight never asks about Serve')
    assert.equal(facts.outbound.length, RELEASE_ORIGINS.length)
    assert.equal(facts.ports.sandboxFree, 300)
    const report = evaluateHostFacts(facts)
    assert.deepEqual(report.checks.filter((c) => c.status !== 'passed'), [])
  })

  test('the Docker probe leaves nothing behind and asks Docker to remove its container', async () => {
    const probes = fakeProbes()
    const facts = await gatherHostFacts({ uid: 1001, root: '/home/operator/.local/share/curia' }, probes)
    const run = probes.calls.find((c) => c[0] === 'docker' && c[1] === 'run')
    assert.ok(run.includes('--rm'), 'the probe container removes itself')
    const name = run[run.indexOf('--name') + 1]
    assert.match(name, /^curia-preflight-/)
    const dir = run[run.indexOf('-v') + 1].split(':')[0]
    assert.equal(existsSync(dir), false, 'the probe directory is gone')
    assert.deepEqual(facts.docker.probe, { mount: true, network: true })
  })

  test('a probe that hangs is removed by force and reported', async () => {
    const probes = fakeProbes({
      exec: async (file, args) => {
        const line = [file, ...args].join(' ')
        if (line.startsWith('docker run ')) return { ok: false, stdout: '', stderr: 'context deadline exceeded', code: 124, timedOut: true }
        return fakeProbes().exec(file, args)
      },
    })
    const seen = []
    const exec = probes.exec
    probes.exec = async (file, args) => { seen.push([file, ...args].join(' ')); return exec(file, args) }
    const facts = await gatherHostFacts({ uid: 1001, root: '/home/operator/.local/share/curia' }, probes)
    assert.ok(seen.some((l) => l.startsWith('docker rm -f curia-preflight-')), 'the container is removed by force')
    assert.equal(facts.docker.probe.mount, false)
    assert.match(facts.docker.probe.error, /deadline/)
  })

  test('a busy port is reported with its holder, and the port probe closes its socket', async () => {
    const holder = createServer()
    await new Promise((r) => holder.listen(0, '127.0.0.1', r))
    const port = holder.address().port
    const probes = fakeProbes({
      exec: async (file, args) => {
        if (file === 'ss') return { ok: true, stdout: `LISTEN 0 511 127.0.0.1:${port} 0.0.0.0:* users:(("node",pid=4242,fd=20))\n` }
        return fakeProbes().exec(file, args)
      },
    })
    const facts = await gatherHostFacts({ uid: 1001, root: '/home/operator/.local/share/curia', ports: [{ port, holder: 'a test' }], sandbox: { from: port + 1, to: port + 3 } }, probes)
    assert.deepEqual(facts.ports.busy, [{ port, process: 'node (pid 4242)' }])
    assert.equal(facts.ports.sandboxFree, 3)
    holder.close()
    // The probe listened on the sandbox ports and let them go: we can take one.
    const again = createServer()
    await new Promise((resolve, reject) => again.once('error', reject).listen(port + 1, '0.0.0.0', resolve))
    again.close()
  })

  test('a host without Docker, Compose, or Tailscale reports each as absent', async () => {
    const probes = fakeProbes({ exec: async (file, args) => ({ ok: false, stdout: '', stderr: `${file}: not found`, code: 127, missing: true }) })
    const facts = await gatherHostFacts({ uid: 1001, root: '/home/operator/.local/share/curia' }, probes)
    assert.equal(facts.docker, null)
    assert.equal(facts.compose, null)
    assert.equal(facts.tailscale, null)
    const report = evaluateHostFacts(facts)
    assert.deepEqual(report.checks.filter((c) => c.status === 'refused').map((c) => c.name), ['Docker Engine', 'Docker capabilities', 'Docker Compose', 'Tailscale', 'Docker socket group'])
  })

  test('a tailscaled that does not answer reads as not running, and the node facts are unknown', async () => {
    const probes = fakeProbes({
      exec: async (file, args) => {
        const line = [file, ...args].join(' ')
        if (line === 'tailscale status --json') return { ok: false, stdout: '', stderr: 'failed to connect to local tailscaled; it doesn\'t appear to be running\n', code: 1 }
        return fakeProbes().exec(file, args)
      },
    })
    const facts = await gatherHostFacts({ uid: 1001, root: '/home/operator/.local/share/curia' }, probes)
    assert.deepEqual(facts.tailscale.daemon, { running: false, error: 'failed to connect to local tailscaled; it doesn\'t appear to be running' })
    assert.equal(facts.tailscale.backendState, 'Unknown')
    assert.deepEqual(facts.tailscale.certDomains, [])
  })

  test('a Docker daemon the client cannot reach reads as not running', async () => {
    const probes = fakeProbes({
      exec: async (file, args) => {
        const line = [file, ...args].join(' ')
        if (line === 'docker version --format json') return { ok: false, stdout: JSON.stringify({ Client: { Version: '27.5.1' } }), stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock', code: 1 }
        return fakeProbes().exec(file, args)
      },
    })
    const facts = await gatherHostFacts({ uid: 1001, root: '/home/operator/.local/share/curia' }, probes)
    assert.equal(facts.docker.server, null)
    assert.match(facts.docker.error, /Cannot connect/)
    assert.equal(facts.docker.probe, null, 'no probe container runs without a daemon')
  })

  test('the disk fact is measured at the nearest existing ancestor of the root', async () => {
    const asked = []
    const probes = fakeProbes({ freeDiskBytes: (path) => { asked.push(path); return 40 * GiB } })
    const home = mkdtempSync(join(tmpdir(), 'curia-preflight-'))
    try {
      const facts = await gatherHostFacts({ uid: 1001, root: join(home, 'nested', 'curia') }, probes)
      assert.deepEqual(asked, [home])
      assert.equal(facts.disk.path, home)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('preflight', () => {
  test('gathers, evaluates, prints, and returns the report', async () => {
    let out = ''
    const report = await preflight({ uid: 1001, root: '/home/operator/.local/share/curia', stdout: { write: (s) => { out += s } } }, fakeProbes())
    assert.equal(report.ok, true)
    assert.match(out, /^ok\s+operating system\s+Ubuntu 24\.04\.2 LTS/m)
    assert.match(out, /12 checks passed/)
  })

  test('accepts facts instead of probing', async () => {
    let out = ''
    const report = await preflight({ facts: ubuntu({ uid: 0 }), stdout: { write: (s) => { out += s } } })
    assert.equal(report.ok, false)
    assert.ok(report.refusal instanceof Refusal)
    assert.match(out, /refused\s+operator/)
  })
})
