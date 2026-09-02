import { isAbsolute, join } from 'node:path'

// Where the service data of an installation lives, inside the seven boundaries
// of the installation root (#867, implementing #851).
//
// One function answers the question for every process: the lifecycle interface
// that writes the Compose project, the daemon that writes the paths, the
// overseer that reads them, and the tests that inspect the Compose bundle. Each
// path sits in the boundary whose lifecycle class it has, so the survival
// contract of the root (`config/`, `secrets/`, `state/`, and `work/` preserved;
// `versions/`, `cache/`, and `run/` replaceable) applies to it with no extra
// rule.
//
//   state/                    the journal, attachments, results, backups, the
//                             preview registry, and the daemon's own token stores
//   work/                     worktrees, review checkouts, and the per-session
//                             config directories, which the daemon calls its
//                             workspace root
//   work/cfg/curia-overseer   the overseer's config directory and native sessions
//   cache/home                HOME in every service container: tool caches and
//                             nothing Curia has to keep
//   cache/overseer-repos      the overseer's mirrors of origin
//   run/overseer-tokens       the overseer's renewable installation tokens, one
//                             file per owner, rewritten by the daemon
//
// The secret files themselves are the catalogue in `secrets.mjs`.
export function serviceLayout(root) {
  if (typeof root !== 'string' || !isAbsolute(root)) {
    throw new Error(`the installation root must be an absolute path, got ${root}`)
  }
  const at = (...parts) => join(root, ...parts)
  return Object.freeze({
    root,
    config: at('config'),
    secrets: at('secrets'),
    state: at('state'),
    work: at('work'),
    cache: at('cache'),
    run: at('run'),
    overseerConfigDir: at('work', 'cfg', 'curia-overseer'),
    home: at('cache', 'home'),
    overseerRepos: at('cache', 'overseer-repos'),
    overseerTokens: at('run', 'overseer-tokens'),
  })
}

// The five long-running services of an installation, in Compose order.
export const SERVICES = Object.freeze(['daemon', 'tmux', 'ttyd', 'dashboard', 'overseer'])

// What each container may see of the installation root, as layout paths and
// modes. This is the container-access contract of #851, and the Compose bundle
// is inspected against it:
//
//   - the service reads `config/` and writes its `config.yaml` for the app's
//     settings screen, owns every secret file, and writes the narrow state,
//     work, cache, and runtime paths it uses;
//   - the tmux runtime holds the panes that run `docker run` against host
//     paths, so it sees the work tree and the shared home and nothing else;
//   - the attach surface sees nothing of the root, only the tmux socket;
//   - the app sees nothing of the root and reaches configuration through the
//     service;
//   - the overseer sees its own config directory, its mirrors, and its
//     renewable tokens read-only. Its model credential reaches it as a copy in
//     its config directory, written by the service, so no secret file is
//     mounted into the container that holds a shell.
export const SERVICE_MOUNTS = Object.freeze({
  daemon: Object.freeze([
    Object.freeze({ path: 'config', mode: 'rw' }),
    Object.freeze({ path: 'secrets', mode: 'rw' }),
    Object.freeze({ path: 'state', mode: 'rw' }),
    Object.freeze({ path: 'work', mode: 'rw' }),
    Object.freeze({ path: 'cache', mode: 'rw' }),
    Object.freeze({ path: 'run', mode: 'rw' }),
  ]),
  tmux: Object.freeze([
    Object.freeze({ path: 'work', mode: 'rw' }),
    Object.freeze({ path: 'home', mode: 'rw' }),
  ]),
  ttyd: Object.freeze([]),
  dashboard: Object.freeze([]),
  overseer: Object.freeze([
    Object.freeze({ path: 'overseerConfigDir', mode: 'rw' }),
    Object.freeze({ path: 'overseerRepos', mode: 'rw' }),
    Object.freeze({ path: 'overseerTokens', mode: 'ro' }),
  ]),
})

// The containers that may reach the Docker socket: the service, which runs
// agent containers as siblings, and the tmux runtime, whose panes run
// `docker run`. The app, the attach surface, and the overseer never do.
export const DOCKER_SOCKET_SERVICES = Object.freeze(['daemon', 'tmux'])
