import { join } from 'node:path'

// The stable host launcher: `~/.local/bin/curia`.
//
// The bootstrap writes it once per installation and no update rewrites it. It
// is one POSIX shell script with the installation root written into it, so a
// nondefault root stays explicit without the operator typing it. On every run
// it reads `state/installation.json`, picks the version the record names, and
// execs that version's pinned Node runtime on that version's entry point with
// CURIA_ROOT exported. It carries no other logic: the lifecycle interface under
// the active version owns everything else, which is what lets an update change
// the interface without touching the launcher.
//
// It exits `refused` (3) when the record is missing or the active version is
// incomplete, and says which file is missing. That is the launcher's one
// refusal, and it matches the lifecycle interface's own refused code.

export function launcherPath(env) {
  return join(env.HOME ?? '', '.local', 'bin', 'curia')
}

export function renderLauncher({ root }) {
  if (root.includes("'")) throw new Error(`the installation root must not contain a single quote: ${root}`)
  return `#!/bin/sh
# Curia launcher. Written by the Curia bootstrap; an update never rewrites it.
# It runs the lifecycle interface of the active installed version.
CURIA_ROOT='${root}'
export CURIA_ROOT

record="$CURIA_ROOT/state/installation.json"
if [ ! -r "$record" ]; then
  echo "curia: no installation record at $record. Run the bootstrap again to reinstall, or delete the launcher if Curia was purged." >&2
  exit 3
fi

version=$(sed -n 's/^[[:space:]]*"activeVersion"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*$/\\1/p' "$record" | head -n 1)
if [ -z "$version" ]; then
  echo "curia: $record names no active version. Run the bootstrap again to reinstall." >&2
  exit 3
fi

node="$CURIA_ROOT/versions/$version/node/bin/node"
entry="$CURIA_ROOT/versions/$version/cli/bin/curia.mjs"
for required in "$node" "$entry"; do
  if [ ! -f "$required" ]; then
    echo "curia: the active version $version is incomplete: $required is missing. Run the bootstrap again to reinstall the active version." >&2
    exit 3
  fi
done

exec "$node" "$entry" "$@"
`
}
