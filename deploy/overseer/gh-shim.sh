#!/usr/bin/env bash
# The overseer's `gh` shim (#327, installing the other half of #313; reading a
# minted token since #392).
#
# The container holds ONE READ-ONLY TOKEN PER RESOURCE OWNER — one file named
# `<owner>` in the tokens tree below — and `gh` reads a single `GH_TOKEN`. So the
# image installs this script as `gh` on PATH, ahead of the real binary, and it
# picks the owner off the command line before it execs.
#
# THE TOKEN IS A FILE AND NOT A VARIABLE (#392). The daemon mints an installation
# token per owner and rewrites these files about every fifty minutes, because an
# installation token lives one hour. A variable would be frozen at container
# create. A file is read at the moment this script runs, so `gh` always gets the
# live one and nothing is restarted.
#
# git needs no shim: one `credential.https://github.com/<owner>.helper` line per
# owner routes every clone and fetch, measured on a real `git ls-remote` in
# docs/live-checks/313-overseer-github-token.md. This is the other half of that
# measurement, and it is the half that has to guess.
#
# HOW IT PICKS, in order. The first rule that answers wins:
#
#   1. `--repo <owner>/<repo>`, `-R <owner>/<repo>`, `--repo=<owner>/<repo>`
#   2. `repos/<owner>/…` anywhere in an argument — the `gh api` path shape
#   3. a bare `<owner>/<repo>` argument — what `gh repo clone alp82/curia` uses,
#      and the checkout pass of #312 runs exactly that
#   4. the checkout directory the process stands in, which #312 names
#      `<owner>__<repo>`, searched from `$PWD` upwards
#
# NO OWNER MEANS NO TOKEN. Every inherited GH_TOKEN is dropped first, so a
# command this script cannot route carries no credential rather than the wrong
# owner's. `gh` then refuses the call outright and says to run `gh auth login`
# (measured, #392 section 3), which is louder and safer than a token crossing an
# owner boundary. git is the softer half: it falls through to an anonymous read,
# which reads every public repo and answers 404 on a private one (#313 section 2).
#
# The token never reaches the command line: it is exported into the child's
# environment, because `ps` on this box is readable by every user (#155).
set -uo pipefail

REAL="${CURIA_GH_REAL:-/usr/local/libexec/curia/gh}"

# The tree the daemon writes and this container mounts read-only. Compose states
# the same path on both sides, and the default here is that path — one spelling
# of one directory, or a token nobody finds.
TOKENS="${CURIA_OVERSEER_TOKEN_DIR:-/home/alp/curia-work/overseer/tokens}"

# `alp82` → `alp82`, `Get-Alfredo` → `get-alfredo`. The same rule as
# overseertoken.mjs `overseerTokenFile`, which is what names the file the daemon
# writes. A GitHub login is unique without regard to case, so lower case is what
# makes one file answer every spelling a command line carries.
slug() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

owner_from_args() {
  local arg owner=''
  # Rule 1: the explicit flag, whatever else the line carries.
  local i=1
  local -a args=("$@")
  while [ "$i" -le "$#" ]; do
    arg="${args[$((i - 1))]}"
    case "$arg" in
      --repo|-R)
        owner="${args[$i]:-}"
        ;;
      --repo=*)
        owner="${arg#--repo=}"
        ;;
    esac
    if [ -n "$owner" ]; then
      printf '%s' "${owner%%/*}"
      return 0
    fi
    i=$((i + 1))
  done
  # Rule 2: the `gh api` path shape.
  for arg in "$@"; do
    if [[ "$arg" =~ (^|/)repos/([A-Za-z0-9._-]+)/ ]]; then
      printf '%s' "${BASH_REMATCH[2]}"
      return 0
    fi
  done
  # Rule 3: a bare `owner/repo`, which is how `gh repo clone` names its target.
  for arg in "$@"; do
    if [[ "$arg" =~ ^([A-Za-z0-9._-]+)/[A-Za-z0-9._-]+$ ]]; then
      printf '%s' "${BASH_REMATCH[1]}"
      return 0
    fi
  done
  return 1
}

# The checkout the shell stands in. #312 spells a checkout `<owner>__<repo>`, so
# the directory name IS the owner where the command line says nothing — which is
# the case for `gh issue list` typed inside a checkout, and for `gh auth
# git-credential`, whose whole request arrives on stdin.
owner_from_cwd() {
  local dir="${PWD:-}"
  while [ -n "$dir" ] && [ "$dir" != '/' ]; do
    local base
    base="$(basename "$dir")"
    if [[ "$base" =~ ^([A-Za-z0-9._-]+)__[A-Za-z0-9._-]+$ ]]; then
      printf '%s' "${BASH_REMATCH[1]}"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  return 1
}

owner="$(owner_from_args "$@" || true)"
[ -z "$owner" ] && owner="$(owner_from_cwd || true)"

# A GitHub account name is alphanumerics and hyphens, and it starts with an
# alphanumeric. The rules above read whatever a command line carried, and this
# name becomes a FILE NAME below — so `..` must never reach it.
[[ "$owner" =~ ^[A-Za-z0-9][A-Za-z0-9-]*$ ]] || owner=''

# Dropped unconditionally: this script is the only thing that decides which
# credential a `gh` call carries, and an inherited one would decide it first.
unset GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN

if [ -n "$owner" ]; then
  # `cat` and not `read`: a file the daemon is replacing under us is replaced by
  # a rename, so this reads the old one whole or the new one whole.
  token="$(cat "$TOKENS/$(slug "$owner")" 2>/dev/null || true)"
  [ -n "$token" ] && export GH_TOKEN="$token"
fi

exec "$REAL" "$@"
