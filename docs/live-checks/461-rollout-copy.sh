#!/usr/bin/env bash
# Find a codex rollout on the curia host and copy it into the #461 worktree.
#
# The counter beside this file answers ticket #461, and it needs one input: the
# rollout a real codex session left on disk. Two rounds asked the operator to
# copy that file by hand, and both times nothing arrived. This script exists
# because a hand copy has three ways to fail silently, and none of them tell the
# operator which one happened:
#
#   1. The workspace root is not where the agent guessed.
#   2. A glob matches nothing, so `cp` gets no argument and says little.
#   3. No codex rollout exists at all, because every recent dispatch ran the
#      claude harness. That is not a copy problem, and it needs a codex dispatch.
#
# So this script resolves the root, LISTS what it found, and copies only after
# it has shown its work.
#
# Run it on the curia HOST, from a checkout of this repo:
#
#   bash docs/live-checks/461-rollout-copy.sh            # list candidates only
#   bash docs/live-checks/461-rollout-copy.sh --copy     # list, then copy the best
#
# The agent container cannot run this. It mounts its own worktree and its own
# config dir, and no other agent's config dir is reachable from inside it.
set -eu

TICKET=461
REPO_DIR=alp82__curia
DO_COPY=0
FORCE=0
for a in "$@"; do
  [ "$a" = "--copy" ] && DO_COPY=1
  [ "$a" = "--force" ] && FORCE=1
done

# ---- the workspace root ----------------------------------------------------

# `dispatch.workspace_root` in curia.yaml and `CURIA_WORKSPACE_ROOT` in
# deploy/.env are the same path, and the daemon refuses to boot when they
# disagree. So either one answers this, and the compose default answers it last.
here=$(cd "$(dirname "$0")/../.." && pwd)
root=${CURIA_WORKSPACE_ROOT:-}
if [ -z "$root" ] && [ -f "$here/deploy/.env" ]; then
  root=$(sed -n 's/^CURIA_WORKSPACE_ROOT=//p' "$here/deploy/.env" | tail -1)
fi
[ -z "$root" ] && root=/home/alp/curia-work

if [ ! -d "$root" ]; then
  echo "The workspace root $root does not exist."
  echo "Set CURIA_WORKSPACE_ROOT to the right path and run this again."
  exit 2
fi
echo "workspace root: $root"
echo ""

# ---- the candidates --------------------------------------------------------

# Codex writes every session to \$CODEX_HOME/sessions/<yyyy>/<mm>/<dd>/, and a
# curia dispatch sets CODEX_HOME to the agent config dir. So every rollout on
# this box sits under <root>/cfg/<session>/sessions.
list=$(find "$root/cfg" -path '*/sessions/*' -name 'rollout-*.jsonl' -type f 2>/dev/null | sort)

if [ -z "$list" ]; then
  echo "No codex rollout exists under $root/cfg."
  echo "Every config dir there belongs to a claude dispatch, or it has no session yet."
  echo "Ticket $TICKET needs a codex dispatch of about twenty turns before anything can be counted."
  exit 3
fi

best=""
best_turns=-1
printf '%-8s %-14s %-10s %s\n' 'turns' 'session' 'size' 'rollout'
while IFS= read -r f; do
  [ -z "$f" ] && continue
  # `turn_context` is one record per turn, which is the same field the counter
  # attributes a read to. Counting it here keeps the ranking and the measurement
  # on one definition of a turn.
  turns=$(grep -c '"turn_context"' "$f" || true)
  [ -z "$turns" ] && turns=0
  session=$(printf '%s' "$f" | sed "s|^$root/cfg/||; s|/sessions/.*||")
  size=$(wc -c < "$f" | tr -d ' ')
  # A rollout only answers this ticket when curia armed the pointers for that
  # session. Without them the model had no pointer to re-read, so a count of zero
  # would prove nothing. The check reads the ROLLOUT rather than the config dir,
  # because codex writes the skill catalog into the session itself. So it still
  # answers after the config dir is recycled, and it says what that session saw
  # rather than what its directory holds today.
  pointer=""
  grep -q 'skills/curia-' "$f" || pointer=" (no curia pointer armed)"
  printf '%-8s %-14s %-10s %s%s\n' "$turns" "$session" "$size" "$f" "$pointer"
  # `find | sort` orders by path, and a rollout path carries its own date. So a
  # tie on turns keeps the LATEST one, which ran under the newest pointer.
  if [ -z "$pointer" ] && [ "$turns" -ge "$best_turns" ]; then
    best=$f
    best_turns=$turns
  fi
done <<EOF
$list
EOF
echo ""

if [ -z "$best" ] && [ "$FORCE" = 1 ]; then
  best=$(printf '%s' "$list" | tail -1)
  best_turns=$(grep -c '"turn_context"' "$best" || true)
  echo "No rollout armed a curia pointer. --force takes the last one anyway."
fi
if [ -z "$best" ]; then
  echo "No rollout armed a curia pointer."
  echo "The counter would read zero pointer reads, and that number would mean nothing."
  echo "Ticket $TICKET needs a codex dispatch that curia seeded. Add --force to copy one regardless."
  exit 4
fi

echo "best candidate: $best ($best_turns turns)"
if [ "$best_turns" -lt 15 ]; then
  echo "The ticket asks for about twenty turns. This one is shorter, so read the number with that in mind."
fi

# ---- the copy --------------------------------------------------------------

dest="$root/repos/$REPO_DIR/wt/$TICKET"
if [ "$DO_COPY" = 0 ]; then
  echo ""
  echo "Nothing was copied. Run this again with --copy to put it in $dest."
  exit 0
fi

if [ ! -d "$dest" ]; then
  echo "The worktree $dest does not exist. The agent for ticket $TICKET is not dispatched."
  exit 5
fi
cp "$best" "$dest/rollout-$TICKET.jsonl"
echo ""
echo "copied to $dest/rollout-$TICKET.jsonl"
echo "The agent sees it at /workspace/rollout-$TICKET.jsonl."
