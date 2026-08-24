# ADR-0028: Local-only work is salvaged before a clone dies

**Status**: accepted (2026-08). Built, by [#649](https://github.com/alp82/curia/issues/649).
**Provenance**: [Teardown sees uncommitted work (#649)](https://github.com/alp82/curia/issues/649), charted from the credential incident recorded in [#641](https://github.com/alp82/curia/issues/641). Extends [ADR-0001](0001-github-is-the-only-durable-state-home.md) to the agent's working tree.

## Context

Every guard curia owns against losing an agent's work counts commits.

`hasUnpushedWork` is `git rev-list --count ref..HEAD`. The orphan sweep consults it before removing a clone. The workspace lease consults `commitsOnBranch` and the pull-request state before ending. `resolve.mjs` consults it before pushing, commented "so nothing lives only in a worktree the human may now discard". Four careful, evidence-driven guards, all reading the same fact.

A working tree that an agent has been editing for six hours and has not committed is invisible to every one of them. Cancel does not even ask: it kills the session and `rmSync`s the clone, then says "worktree removed, ticket re-frontiered".

Curia has known this in one narrow place since #297. The Stop hook reads `uncommittedFiles` for charting sessions, because "no commits cannot tell a session that researched nothing from one that wrote findings and never committed them. The second dies with the workspace, silently." That reasoning was never generalized, and the hook is a request to the agent rather than a guarantee.

On August 23, 2026 two codex agents died on an expired credential. `wt/578` held one commit plus roughly 1100 uncommitted lines across ten files. It survived, because the paths that killed those agents preserve the clone, and because the operator archived it by hand before touching anything. The hand-made patch worked because a human was watching.

## Decision

**Curia never destroys a clone holding local-only work without first putting that work somewhere durable, and it never does so silently.**

### Local-only work has two kinds, and they are named apart

**Local-only work** is work that exists in no place but this clone. It is the union of two kinds:

- **Unpushed commits**, which `hasUnpushedCommits` answers (renamed from `hasUnpushedWork`).
- **Uncommitted changes**, which `hasUncommittedChanges` answers, from `git status --porcelain`.

They stay two predicates rather than one widened one. The cross-check callers ask about the pushed tip, and a dirty tree is not a reason to refuse a cross-check or trigger a push. A vague predicate that absorbed both would change behavior at call sites that never asked for it, which is the fault class a precise name exists to prevent.

Untracked files count. A file an agent created and never added is work, and the two ignore files already in place - the repo's `.gitignore` and the clone's own `.git/info/exclude`, which hides `.mcp.json`, `.claude/`, and `.curia-prompt.md` - are what separate work from noise.

### The salvage is a branch on GitHub, not a patch on the box

Curia commits the dirty tree and pushes it as `curia/<n>-salvage-<stamp>`.

A patch file under the workspace root was refused. ADR-0001 says GitHub is the only durable state home, and the box is one box: `backup.mjs` exists precisely because the journal lives on it. But the deciding reason is not durability, it is that nobody reads a patch. The operator's hand-made archive on August 23 saved the work because that operator was watching at that moment. A branch on the tracker is findable later, by the same person, from the same phone that saw the alarm, with no knowledge that an archive directory exists.

A local patch written in addition, best-effort, was refused too. Two copies means two retention stories and neither one gets trusted.

`git add -A` and a commit, never `git diff HEAD`. The diff form silently drops untracked files, honors no ignore rules of its own, and produces a text blob where a ref is wanted. Pushing HEAD carries any unpushed commits along in the same act, which closes cancel's second silent loss for free.

The branch **accumulates**; it never overwrites. One ticket can be salvaged more than once, and a salvage that destroys the previous salvage is this same bug one level up.

The commit is authored by curia. The clone carries the ticket owner's git identity, and a salvage commit under that name would be a lie about who wrote it.

### Each destroying path answers separately, and the split is "is the work landed"

- **Cancel captures, then proceeds.** A teardown was ordered and the teardown happens. Curia's job at an ordered ending is not to argue with the order, it is to not lose the work silently.
- **The workspace lease captures, then proceeds.** The pull request is merged, so anything still dirty is by definition not what landed. Keeping the clone instead would leak disk on the common happy ending, forever, with no sweep able to take it: the orphan sweep would find it dirty and keep it too.
- **The orphan sweep keeps.** Nothing is established and nobody ordered anything. This is the same evidence rule it already runs for commits, where "cannot tell" means keep.
- **`start <n>` refuses**, and so does `map <n>`, which is the charting verb's copy of the same dispatch. `createPrivateClone` opens with an unconditional `rmSync`, and #376 already taught the tick's auto loop to check the path and resume rather than start. The operator's verb gets the same rule in the shape `start` already uses for every other anomaly: refuse, and name the way out, which is `resume <n>`. No salvage branch is spent on a teardown that does not have to happen.
- **The review checkout is untouched.** It is a detached HEAD at a pushed sha and holds nothing that exists nowhere else.

### A failed capture keeps the clone

When the push fails, cancel kills the session and releases the claim and **keeps** the clone, and says all three things. The agent ends, which is what was ordered. Destroying the only copy because a network call failed is the exact shape of the bug this ADR closes, and it would arrive under a line announcing a successful teardown.

### Cancel says it; a keep does not

Cancel's line names the salvage branch, because "worktree removed, ticket re-frontiered" becomes false the moment work was captured, and a branch nobody is told about is a patch nobody reads.

A keep stays journal-only, which is what `orphan_worktree_kept` and `lease_kept` already are. A kept clone has lost nothing. It is rubble, and rubble is not an alarm.

## Consequences

- Salvage branches accumulate in watched repos and nothing deletes them. This is accepted: a salvage branch is a few kilobytes and is the record of a loss, so the person who wants it gone deletes it. Retention would pull in a durable-salvage story - browsing, restoring, expiring - that #649 ruled out of scope.
- The rename of `hasUnpushedWork` touches three call sites. Two of them - the cross-check guard in `dispatch.mjs` and the repair push in `resolve.mjs` - do not change behavior, and the rename is the point: they ask about the pushed tip, and after this ADR there is a second question they must not be mistaken for. The third is the orphan sweep, which decision 4 above deliberately widens to the second question as well.
- Curia becomes a committer in watched repos, on branches no human asked for. The commit author makes that visible rather than hiding it under the ticket owner's name.
- ADR-0001's reach extends from tracker state to the agent's working tree. The claim it makes is unchanged: there is one durable home, and it is not this box.
- The #297 Stop hook nudge for charting sessions stays. It is better to have the agent commit its own findings with its own message than to have curia salvage them under a machine one. The salvage is the floor, not the replacement.
