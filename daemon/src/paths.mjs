// Where the service's mutable data and secrets live (#867, implementing #851).
//
// Two deployments, one answer. Under an installation root (`CURIA_ROOT`), every
// path comes from the lifecycle interface's own layout, so the daemon, the
// overseer, the Compose bundle, and `curia doctor` name the same directories.
// In the source deployment there is no root: the paths are the ones the box
// has run on since #473, spelled here in one place instead of in five modules.
//
// `loadCuriaConfig` attaches the result as `cfg.paths`, and that is the only
// way a module learns where a credential store or a token tree is. A module
// that derived a path from the workspace root on its own would be a second
// answer, free to disagree with the mounts.

import os from 'node:os'
import path from 'node:path'

import { serviceLayout } from '../../cli/src/layout.mjs'
import { secretPath } from '../../cli/src/secrets.mjs'

export function servicePaths({ root = null, workspaceRoot, home = null } = {}) {
  if (root) {
    const layout = serviceLayout(root)
    return Object.freeze({
      root,
      workspaceRoot: layout.work,
      state: layout.state,
      run: layout.run,
      home: layout.home,
      secrets: layout.secrets,
      anthropicStore: secretPath(root, 'anthropic.json'),
      codexAuth: secretPath(root, 'codex-auth.json'),
      overseerRepos: layout.overseerRepos,
      overseerTokens: layout.overseerTokens,
    })
  }
  return Object.freeze({
    root: null,
    workspaceRoot,
    // The journal and its neighbours stay where `index.mjs` puts them
    // (`CURIA_DATA_DIR`, else `daemon/data`).
    state: null,
    run: null,
    // Curia's own home, `home/` inside the workspace root (#473).
    home: home ?? legacyHome(workspaceRoot),
    secrets: null,
    // One file per model provider, mounted read-only into the overseer (#648).
    anthropicStore: path.join(workspaceRoot, 'credentials', 'anthropic.json'),
    // The codex host store, in the home the process runs on (#642).
    codexAuth: path.join(os.homedir(), '.codex', 'auth.json'),
    overseerRepos: path.join(workspaceRoot, 'overseer', 'repos'),
    overseerTokens: path.join(workspaceRoot, 'overseer', 'tokens'),
  })
}

export const legacyHome = (workspaceRoot) => path.join(workspaceRoot, 'home')

// The paths of a loaded config, or the source deployment's answer for a config
// built by hand (the suite builds many of those with only a workspace root).
export function pathsOf(cfg) {
  return cfg.paths ?? servicePaths({ workspaceRoot: cfg.dispatch.workspace_root })
}
