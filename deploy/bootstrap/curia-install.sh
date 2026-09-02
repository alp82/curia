#!/usr/bin/env bash
# The Curia bootstrap (#872, implementing #862, #850, and #855).
#
# One script installs Curia on a supported host, or purges one installation,
# without a Node.js on the host. Download it to a file first, then run it:
#
#     curl -fsSLO https://github.com/alp82/curia/releases/latest/download/curia-install.sh
#     bash curia-install.sh                       install the stable release
#     bash curia-install.sh --root /srv/curia     into a nondefault root
#     bash curia-install.sh --version 1.2.4       an exact published version
#     bash curia-install.sh --purge               purge the default root
#     bash curia-install.sh --purge --root DIR    purge an explicit root
#
# It runs as you, never as root. It downloads every artifact completely
# before it runs anything: the package tarball of @curia-sh/cli from the npm
# registry with the registry's own integrity record, the pinned Node.js
# runtime from nodejs.org with its SHASUMS256.txt, the Compose bundle, its
# checksum, and the release manifest from the GitHub release, and the signed
# stable-release index. Then it proves each download in this shell (the
# package's SHA-512, the runtime's SHA-256, the bundle's SHA-256, the version
# every file names), unpacks the runtime and the package into one temporary
# stage, and has the staged lifecycle interface prove the rest with its own
# code: the stable-release index against the key the package pins, the
# selection, and the release manifest's every check. Only then does it hand
# off to `curia install`, or to `curia purge`, on the staged runtime, with
# CURIA_ROOT set. The lifecycle interface owns everything from there, and the
# stage is removed when it returns.
#
# Exit codes are the lifecycle interface's: 0 ok, 1 failed, 2 usage, 3
# refused (nothing changed). A hand-off exits with the interface's own code.
#
# The four origins can be pointed at a local artifact server, which is how
# the test suite runs this script without a network. Every check still
# applies, and the script says so when an origin is not the published one.
set -euo pipefail

CURIA_BOOTSTRAP_VERSION='source'

PACKAGE='@curia-sh/cli'
NPM_REGISTRY_DEFAULT='https://registry.npmjs.org'
RELEASE_DOWNLOADS_DEFAULT='https://github.com/alp82/curia/releases/download'
NODE_DIST_DEFAULT='https://nodejs.org/dist'
STABLE_INDEX_URL_DEFAULT='https://raw.githubusercontent.com/alp82/curia/main/release/stable.json'

NPM_REGISTRY="${CURIA_BOOTSTRAP_NPM_REGISTRY:-$NPM_REGISTRY_DEFAULT}"
RELEASE_DOWNLOADS="${CURIA_BOOTSTRAP_RELEASE_DOWNLOADS:-$RELEASE_DOWNLOADS_DEFAULT}"
NODE_DIST="${CURIA_BOOTSTRAP_NODE_DIST:-$NODE_DIST_DEFAULT}"
STABLE_INDEX_URL="${CURIA_BOOTSTRAP_STABLE_INDEX_URL:-$STABLE_INDEX_URL_DEFAULT}"

EXIT_OK=0
EXIT_FAILED=1
EXIT_USAGE=2
EXIT_REFUSED=3

say() { printf 'curia-install: %s\n' "$*"; }
refuse() { printf 'curia-install: refused: %s\n' "$*" >&2; exit "$EXIT_REFUSED"; }
fail() { printf 'curia-install: failed: %s\n' "$*" >&2; exit "$EXIT_FAILED"; }

# ---------------------------------------------------------------------------
# The script itself must be whole, and on disk. This runs before anything
# below is even parsed, so a file cut short by an interrupted download
# refuses here instead of running half of itself. Run from a pipe there is
# no file to check, so `curl | bash` refuses on purpose.

check_self() {
  local self="${BASH_SOURCE[0]:-}"
  if [ -z "$self" ] || [ ! -f "$self" ]; then
    refuse 'this script is running from a pipe or a string, so it cannot check that it downloaded completely. Download the script to a file first, then run it: curl -fsSLO https://github.com/alp82/curia/releases/latest/download/curia-install.sh && bash curia-install.sh'
  fi
  if [ "$(tail -n 1 "$self")" != '# curia-install: end' ]; then
    refuse "$self is incomplete: its last line is not the completion marker, so the download was cut short. Download it again."
  fi
}
check_self

usage() {
  cat <<'EOF'
usage: bash curia-install.sh [--root <dir>] [--version <version> [--prerelease]]
       bash curia-install.sh --purge [--root <dir>] [--version <version> [--prerelease]]

Options:
  --root <dir>         The installation root. Default: CURIA_ROOT, else
                       $XDG_DATA_HOME/curia, else ~/.local/share/curia.
  --version <version>  Install an exact published version instead of the
                       stable release the signed index names.
  --prerelease         Allow --version to name a prerelease.
  --purge              Acquire the verified lifecycle interface temporarily
                       and run `curia purge` on the root. Installs nothing.
  --help               Print this text.

Exit codes: 0 ok, 1 failed, 2 usage, 3 refused (nothing changed).
EOF
}

# ---------------------------------------------------------------------------
# The host: unprivileged, Linux on x86-64, and the tools the script uses.
# The lifecycle interface's own preflight checks the rest once it runs.

check_host() {
  if [ "$(id -u)" = '0' ]; then
    refuse 'this script runs as root. Curia runs unprivileged: run it as the user that will own the installation, without sudo.'
  fi
  if [ -z "${HOME:-}" ] || [ ! -d "$HOME" ]; then
    refuse 'HOME is not set to a directory. The launcher lives at ~/.local/bin/curia, so the script needs a home directory.'
  fi
  local system machine
  system=$(uname -s)
  machine=$(uname -m)
  if [ "$system" != 'Linux' ]; then
    refuse "this host runs $system. Curia supports Linux on x86_64 only (Ubuntu 24.04 and Debian 13)."
  fi
  if [ "$machine" != 'x86_64' ]; then
    refuse "this host is $machine. Curia publishes artifacts for x86_64 only."
  fi
  local missing=() tool
  for tool in curl tar gzip sha256sum sha512sum base64 od mktemp sed grep cut head tail tr; do
    command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    refuse "this script needs ${missing[*]} on the PATH. Install the package that provides each one (curl, tar, gzip, and coreutils on Ubuntu and Debian) and run it again."
  fi
}

# ---------------------------------------------------------------------------
# Downloads. Each file lands as `.part` and is renamed only when curl says
# the transfer completed, so a partial file is never read as a whole one.

CURL_PROTO='=https'

download() {
  local url=$1 dest=$2 what=$3 status
  rm -f "$dest.part"
  set +e
  curl --fail --silent --show-error --location --proto "$CURL_PROTO" --proto-redir "$CURL_PROTO" \
    --connect-timeout 30 --max-time 1800 --retry 3 --retry-connrefused \
    --output "$dest.part" "$url" 2>"$dest.curl"
  status=$?
  set -e
  case "$status" in
    0) ;;
    18)
      rm -f "$dest.part"
      refuse "the download of $what was interrupted before it completed ($(head -n 1 "$dest.curl")). Run the script again."
      ;;
    22)
      rm -f "$dest.part"
      refuse "$what is not at $url ($(head -n 1 "$dest.curl" | sed 's/^curl: ([0-9]*) //')). Check that the version is published, and run the script again."
      ;;
    *)
      rm -f "$dest.part"
      refuse "could not download $what from $url (curl exit $status: $(head -n 1 "$dest.curl")). Check outbound access and run the script again."
      ;;
  esac
  rm -f "$dest.curl"
  if [ ! -s "$dest.part" ]; then
    rm -f "$dest.part"
    refuse "the download of $what from $url is empty. Run the script again."
  fi
  mv "$dest.part" "$dest"
}

# The first quoted value of a JSON key, read by line. Enough for the flat
# facts this script reads before it has a Node.js to parse JSON with; the
# staged lifecycle interface reparses every file properly.
json_string() {
  local key=$1 file=$2
  sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$file" | head -n 1
}

sha256_of() { sha256sum "$1" | cut -d ' ' -f 1; }
sha512_of() { sha512sum "$1" | cut -d ' ' -f 1; }

# An npm `sha512-<base64>` integrity value as lowercase hex.
sri_to_hex() {
  printf '%s' "${1#sha512-}" | base64 -d 2>/dev/null | od -An -v -tx1 | tr -d ' \n'
}

# ---------------------------------------------------------------------------
# The command line.

ROOT=''
REQUESTED=''
PRERELEASE='false'
COMMAND='install'

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --root)
        [ "$#" -ge 2 ] || { printf 'curia-install: --root needs a directory\n' >&2; exit "$EXIT_USAGE"; }
        ROOT=$2
        shift 2
        ;;
      --version)
        [ "$#" -ge 2 ] || { printf 'curia-install: --version needs a version\n' >&2; exit "$EXIT_USAGE"; }
        REQUESTED=$2
        shift 2
        ;;
      --prerelease) PRERELEASE='true'; shift ;;
      --purge) COMMAND='purge'; shift ;;
      --help|-h) usage; exit "$EXIT_OK" ;;
      *)
        printf 'curia-install: unknown option: %s\n' "$1" >&2
        usage >&2
        exit "$EXIT_USAGE"
        ;;
    esac
  done
}

# The installation root, resolved the way the lifecycle interface resolves
# it, so the root this script names is the root `curia install` opens.
resolve_root() {
  if [ -n "$ROOT" ]; then
    :
  elif [ -n "${CURIA_ROOT:-}" ]; then
    ROOT=$CURIA_ROOT
  elif [ -n "${XDG_DATA_HOME:-}" ]; then
    ROOT="$XDG_DATA_HOME/curia"
  else
    ROOT="$HOME/.local/share/curia"
  fi
  case "$ROOT" in
    /*) ;;
    *) refuse "the installation root must be an absolute path, got $ROOT." ;;
  esac
  case "$ROOT" in
    *"'"*) refuse "the installation root must not contain a single quote: $ROOT. The launcher writes the root into a shell script." ;;
  esac
}

# ---------------------------------------------------------------------------
# The stage: one temporary directory that holds every download and, once
# proven, the unpacked runtime and package at the names an installed version
# uses, so `curia install` can move them into versions/<version>/ as they are.

STAGE=''

make_stage() {
  STAGE=$(mktemp -d "${TMPDIR:-/tmp}/curia-bootstrap.XXXXXXXX")
  chmod 0700 "$STAGE"
  trap 'rm -rf "$STAGE"' EXIT
}

# ---------------------------------------------------------------------------

main() {
  parse_args "$@"
  check_host
  resolve_root

  if [ "$NPM_REGISTRY" != "$NPM_REGISTRY_DEFAULT" ] || [ "$RELEASE_DOWNLOADS" != "$RELEASE_DOWNLOADS_DEFAULT" ] \
     || [ "$NODE_DIST" != "$NODE_DIST_DEFAULT" ] || [ "$STABLE_INDEX_URL" != "$STABLE_INDEX_URL_DEFAULT" ]; then
    CURL_PROTO='=http,https'
    say "origins overridden: package $NPM_REGISTRY, release $RELEASE_DOWNLOADS, runtime $NODE_DIST, index $STABLE_INDEX_URL"
  fi

  say "bootstrap $CURIA_BOOTSTRAP_VERSION"
  if [ "$COMMAND" = 'purge' ]; then
    say "purge of $ROOT: the lifecycle interface is acquired temporarily, asks for confirmation, and nothing is installed"
  else
    say "installation root: $ROOT"
  fi

  make_stage

  # 1. The stable-release index, read here only to choose what to download.
  #    The staged package verifies its signature below.
  download "$STABLE_INDEX_URL" "$STAGE/stable.json" 'the stable-release index'
  local version selection
  if [ -n "$REQUESTED" ]; then
    version=$REQUESTED
    selection='the exact version'
  else
    version=$(json_string stable "$STAGE/stable.json")
    if [ -z "$version" ]; then
      refuse 'the stable-release index names no stable release. Wait for the next promotion, or install an exact version with --version.'
    fi
    selection='the stable release'
  fi
  case "$version" in
    *[!0-9A-Za-z.-]*|'') refuse "$version is not a release version like 1.2.3." ;;
  esac
  say "selected $version, $selection"

  # 2. Every download, before anything runs.
  local bare='cli'
  download "$NPM_REGISTRY/$PACKAGE/$version" "$STAGE/packument.json" "the registry record of $PACKAGE@$version"
  download "$NPM_REGISTRY/$PACKAGE/-/$bare-$version.tgz" "$STAGE/cli.tgz" "the package $PACKAGE@$version"

  local integrity
  integrity=$(json_string integrity "$STAGE/packument.json")
  case "$integrity" in
    sha512-*) ;;
    *) refuse "the registry records no sha512 integrity for $PACKAGE@$version, so the package cannot be proven. Report it at https://github.com/alp82/curia/issues." ;;
  esac
  if [ "$(sha512_of "$STAGE/cli.tgz")" != "$(sri_to_hex "$integrity")" ]; then
    refuse "package integrity: the downloaded $PACKAGE@$version does not have the SHA-512 the registry records. The tarball was substituted or damaged in transit: do not use it, and run the script again."
  fi

  mkdir -p "$STAGE/cli"
  tar -xzf "$STAGE/cli.tgz" -C "$STAGE/cli" --strip-components=1 \
    || refuse "the package $PACKAGE@$version is not a gzipped tar archive."
  [ -f "$STAGE/cli/package.json" ] || refuse "the package $PACKAGE@$version carries no package.json."
  local package_version node_version
  package_version=$(json_string version "$STAGE/cli/package.json")
  if [ "$package_version" != "$version" ]; then
    refuse "version mismatch: the package names version $package_version, and $version was selected."
  fi
  node_version=$(sed -n 's/^[[:space:]]*"node"[[:space:]]*:[[:space:]]*"\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)".*$/\1/p' "$STAGE/cli/package.json" | head -n 1)
  if [ -z "$node_version" ]; then
    refuse "the package $PACKAGE@$version pins no Node.js runtime (curia.node in its package.json), so this bootstrap cannot stage its runtime."
  fi

  local node_name="node-v$node_version-linux-x64"
  download "$NODE_DIST/v$node_version/SHASUMS256.txt" "$STAGE/SHASUMS256.txt" "the checksums of Node.js v$node_version"
  download "$NODE_DIST/v$node_version/$node_name.tar.gz" "$STAGE/node.tar.gz" "Node.js v$node_version"

  local manifest_name="curia-manifest-$version.json"
  local bundle_name="curia-bundle-$version.tar.gz"
  download "$RELEASE_DOWNLOADS/v$version/$manifest_name" "$STAGE/release-manifest.json" "$manifest_name"
  download "$RELEASE_DOWNLOADS/v$version/$bundle_name" "$STAGE/bundle.tar.gz" "$bundle_name"
  download "$RELEASE_DOWNLOADS/v$version/$bundle_name.sha256" "$STAGE/bundle.tar.gz.sha256" "$bundle_name.sha256"

  # 3. The checks this shell can make. The staged interface repeats and
  #    completes them with its own code before anything is handed off.
  local expected actual
  expected=$( (grep "  $node_name.tar.gz\$" "$STAGE/SHASUMS256.txt" || true) | head -n 1 | cut -d ' ' -f 1)
  if [ -z "$expected" ]; then
    refuse "SHASUMS256.txt does not list $node_name.tar.gz, so Node.js v$node_version cannot be proven."
  fi
  if [ "$(sha256_of "$STAGE/node.tar.gz")" != "$expected" ]; then
    refuse "Node.js v$node_version checksum: the downloaded $node_name.tar.gz does not have the SHA-256 that SHASUMS256.txt lists. The runtime was substituted or damaged in transit: do not use it, and run the script again."
  fi

  actual=$(sha256_of "$STAGE/bundle.tar.gz")
  expected=$(cut -d ' ' -f 1 "$STAGE/bundle.tar.gz.sha256")
  if [ "$actual" != "$expected" ]; then
    refuse "bundle checksum: $bundle_name does not have the SHA-256 its .sha256 file names. The bundle was substituted or damaged in transit: do not use it, and run the script again."
  fi
  if [ "$(json_string sha256 "$STAGE/release-manifest.json")" != "$actual" ]; then
    refuse "bundle checksum: $bundle_name does not have the SHA-256 the release manifest binds. The bundle was substituted or damaged in transit: do not use it, and run the script again."
  fi
  local manifest_version
  manifest_version=$(json_string version "$STAGE/release-manifest.json")
  if [ "$manifest_version" != "$version" ]; then
    refuse "version mismatch: the release manifest is for version $manifest_version, and $version was selected."
  fi

  # 4. The runtime, unpacked and proven to be the pinned version.
  mkdir -p "$STAGE/node"
  tar -xzf "$STAGE/node.tar.gz" -C "$STAGE/node" --strip-components=1 \
    || refuse "Node.js v$node_version is not a gzipped tar archive."
  local node="$STAGE/node/bin/node"
  [ -x "$node" ] || refuse "Node.js v$node_version has no bin/node. If ${TMPDIR:-/tmp} is mounted noexec, set TMPDIR to a directory that allows execution and run the script again."
  local reported
  reported=$("$node" --version 2>/dev/null) || refuse "the staged Node.js at $node does not run. If ${TMPDIR:-/tmp} is mounted noexec, set TMPDIR to a directory that allows execution and run the script again."
  if [ "$reported" != "v$node_version" ]; then
    refuse "the staged Node.js reports $reported, not v$node_version, which the package pins."
  fi
  say "Node.js $reported staged from $node_name.tar.gz"

  # 5. The staged interface proves the index, the selection, and the release
  #    with its own code, from the files already on disk. No network.
  cat >"$STAGE/verify.mjs" <<'EOF'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [stage, version, requested, prerelease] = process.argv.slice(2)
const load = (file) => import(pathToFileURL(join(stage, 'cli', 'src', file)).href)
const { verifyStagedRelease } = await load('manifest.mjs')
const { fetchStableIndex, selectRelease, renderSelection } = await load('stable.mjs')
const { Refusal } = await load('exit.mjs')
const read = (name, encoding) => readFileSync(join(stage, name), encoding)

const index = await fetchStableIndex({ stdout: process.stdout }, { stableIndex: async () => read('stable.json', 'utf8') })
if (!index.ok) {
  process.stderr.write(`curia-install: refused: ${index.error}\n`)
  process.exit(3)
}
let selected
try {
  selected = selectRelease(index.index, { requested: requested || null, prerelease: prerelease === 'true' })
} catch (e) {
  if (!(e instanceof Refusal)) throw e
  process.stderr.write(`curia-install: refused: ${e.message}\n`)
  process.exit(3)
}
process.stdout.write(renderSelection(selected))
if (selected.version !== version) {
  process.stderr.write(`curia-install: refused: the stable-release index selects ${selected.version}, and ${version} was staged. Run the script again.\n`)
  process.exit(3)
}

const packument = JSON.parse(read('packument.json', 'utf8'))
const report = await verifyStagedRelease(
  { version, tarball: read('cli.tgz'), archive: read('bundle.tar.gz'), checksum: read('bundle.tar.gz.sha256', 'utf8') },
  { stdout: process.stdout },
  {
    packument: async () => ({ integrity: packument?.dist?.integrity ?? null, attested: Boolean(packument?.dist?.attestations) }),
    releaseManifest: async () => read('release-manifest.json', 'utf8'),
    attestation: async () => ({ ok: false, error: 'provenance is verified by curia doctor, after installation' }),
  },
)
if (!report.ok) {
  process.stderr.write(`curia-install: refused: ${report.refusal.message}\n`)
  process.exit(3)
}
EOF
  local status=0
  "$node" "$STAGE/verify.mjs" "$STAGE" "$version" "$REQUESTED" "$PRERELEASE" || status=$?
  if [ "$status" -ne 0 ]; then
    [ "$status" -eq "$EXIT_REFUSED" ] && exit "$EXIT_REFUSED"
    fail "the staged lifecycle interface could not verify the release (exit $status)."
  fi
  rm -f "$STAGE/verify.mjs" "$STAGE/packument.json" "$STAGE/release-manifest.json" "$STAGE/stable.json" "$STAGE/SHASUMS256.txt" "$STAGE/node.tar.gz"

  # 6. The hand-off. The interface owns the root, the record, the launcher,
  #    and the confirmation from here; its exit code is this script's.
  export CURIA_ROOT="$ROOT"
  if [ "$COMMAND" = 'install' ]; then
    export CURIA_STAGE="$STAGE"
  fi
  say "handing off to curia $COMMAND ($PACKAGE@$version on Node.js $reported)"
  status=0
  "$node" "$STAGE/cli/bin/curia.mjs" "$COMMAND" || status=$?
  exit "$status"
}

main "$@"
# curia-install: end
