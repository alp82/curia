# `elayadesign/ai-design-skills` for curia landing-page work

Date: 2026-08-17. I read every file at commit
[`1c1e97c`](https://github.com/elayadesign/ai-design-skills/commit/1c1e97cb9878e236552c772092dda7adcdddbcb2).
I also read curia's current worker installation code and landing-page rules.

## Verdict

Do not add this repository to the map Notes or curia's default worker skills.
Its one skill has useful checks, but its fixed sales funnel and visual rules conflict with settled decisions.

Use selected parts as a reference for
[Try the living-organism prompt as a landing-page experiment](https://github.com/alp82/curia/issues/363).
The experiment, positioning brief, and STE-flavored writing rules take priority over this reference.

## What the repository ships

The repository ships one skill and no code, scripts, templates, or assets.
The tree contains one `SKILL.md`, a README, an MIT license, and a `.gitignore` file
([source tree](https://github.com/elayadesign/ai-design-skills/tree/1c1e97cb9878e236552c772092dda7adcdddbcb2)).

The `landing-page-design` skill covers intake, structure, layouts, conversion copy, SEO, typography, spacing, color, motion, states, and shipping checks.
Useful parts include specific claims, nearby proof, small changes, mobile checks, restrained scroll code, placeholder checks, focus states, semantic HTML, and metadata.

The README calls this a collection, but the inventory lists only `landing-page-design`.
It links a separate redesign repository as a companion, which this repository does not ship
([README lines 9-15](https://github.com/elayadesign/ai-design-skills/blob/1c1e97cb9878e236552c772092dda7adcdddbcb2/README.md#L9-L15)).
The skill directs existing-site upgrades to that companion.
This direction makes the shipped skill a poor fit for improvements to curia's current page.

The skill has two parts. Part A covers intake, a fixed twelve-item page structure, conversion rules, copy, build order, and search metadata
([Part A](https://github.com/elayadesign/ai-design-skills/blob/1c1e97cb9878e236552c772092dda7adcdddbcb2/skills/landing-page-design/SKILL.md#L22-L142)).
Part B fixes fonts, type sizes, spacing, radii, colors, icons, motion, content, states, and page requirements
([Part B](https://github.com/elayadesign/ai-design-skills/blob/1c1e97cb9878e236552c772092dda7adcdddbcb2/skills/landing-page-design/SKILL.md#L146-L357)).
It also requires a plan and copy package before code
([output format](https://github.com/elayadesign/ai-design-skills/blob/1c1e97cb9878e236552c772092dda7adcdddbcb2/skills/landing-page-design/SKILL.md#L361-L373)).

## Installation into a curia worker

Upstream documents a project-level Claude Code install at `.claude/skills/landing-page-design`.
It tells Codex users to copy the full skill into `AGENTS.md`
([install instructions](https://github.com/elayadesign/ai-design-skills/blob/1c1e97cb9878e236552c772092dda7adcdddbcb2/README.md#L19-L64)).
Those instructions do not describe curia's worker installation.

Curia's current [self-host guide](../../README.md) vendors its worker skills under `skills/`.
The tracked config points `skills.root` there and names each installed skill
([config](../../config/curia.yaml)).
For each worker, the daemon copies or links `<root>/<name>` into that worker's skill directory
([installer](../../daemon/src/workspace.mjs)).

The safe curia installation would vendor the reviewed directory as `skills/landing-page-design`.
It would also record the upstream commit and license, then add the name to `skills.install`.
Do not copy from a moving `main` branch during worker startup.

The daemon can use `~/.claude/skills` as an alternate root.
That root must contain `landing-page-design/SKILL.md`, not the upstream repository's extra `skills/` directory.
If curia uses that root, every listed worker skill must also exist there.

## License and trust

The repository uses the MIT license.
The license permits use, changes, copies, publication, sublicensing, and sale.
It requires the copyright and permission notice in copies or substantial portions
([license](https://github.com/elayadesign/ai-design-skills/blob/1c1e97cb9878e236552c772092dda7adcdddbcb2/LICENSE#L1-L21)).
The README's statement that attribution is not needed omits this notice condition
([README lines 74-76](https://github.com/elayadesign/ai-design-skills/blob/1c1e97cb9878e236552c772092dda7adcdddbcb2/README.md#L74-L76)).

The reviewed content contains no shell commands except installation commands.
It contains no executable helper, remote fetch instruction during use, or hidden reference file.
It does tell a worker to use a companion skill from another repository
([scope lines 14-18](https://github.com/elayadesign/ai-design-skills/blob/1c1e97cb9878e236552c772092dda7adcdddbcb2/skills/landing-page-design/SKILL.md#L14-L18)).
Curia's closed tool rule prevents a worker from installing that companion without operator approval.

The skill tells workers to invent believable names and nonround numbers when real content is absent
([content rules](https://github.com/elayadesign/ai-design-skills/blob/1c1e97cb9878e236552c772092dda7adcdddbcb2/skills/landing-page-design/SKILL.md#L299-L311)).
Curia must not use that rule for proof, users, results, offers, or risk reversal.

The main trust risk is instruction scope, not executable code.
The frontmatter tells every web task to consult the skill, including reviews and prototypes.
The body calls its visual system nonnegotiable and says it wins over framework defaults
([scope lines 1-16](https://github.com/elayadesign/ai-design-skills/blob/1c1e97cb9878e236552c772092dda7adcdddbcb2/skills/landing-page-design/SKILL.md#L1-L16)).
An installed copy would therefore influence every landing-page session, even without a map note.

The repository has three verified commits from one contributor.
The reviewed commit dates from 2026-07-29
([commit history](https://github.com/elayadesign/ai-design-skills/commits/1c1e97cb9878e236552c772092dda7adcdddbcb2)).
The repository has no [tag](https://github.com/elayadesign/ai-design-skills/tags) or
[release](https://github.com/elayadesign/ai-design-skills/releases).
This small history gives curia no release boundary or independent review record.

## Fit with curia's standing rules

### Rules that help

The skill and the [positioning brief](../landing-page/positioning.md) both require one audience and one clear purpose.
Both prefer specific facts, proof beside claims, mobile readability, and direct copy.
The skill also bans several AI clichés, uses active voice, and asks for sentence-case headings
([content rules](https://github.com/elayadesign/ai-design-skills/blob/1c1e97cb9878e236552c772092dda7adcdddbcb2/skills/landing-page-design/SKILL.md#L299-L311)).

Its accessibility and shipping checks can help a page review.
Useful checks include focus states, dead links, a skip link, metadata, alt text, and semantic HTML
([states and shipping](https://github.com/elayadesign/ai-design-skills/blob/1c1e97cb9878e236552c772092dda7adcdddbcb2/skills/landing-page-design/SKILL.md#L313-L339)).

### Rules that conflict

The positioning brief already fixes the audience, promise, three claims, proof, honesty block, and page order.
The skill instead requires a sales CTA, testimonials, six to twelve FAQs, risk reversal, and a repeated final CTA
([required structure](https://github.com/elayadesign/ai-design-skills/blob/1c1e97cb9878e236552c772092dda7adcdddbcb2/skills/landing-page-design/SKILL.md#L52-L72)).
Those items do not fit a manual, self-hosted project with no service or package.

The brief bans generic agent marketing and unsupported proof.
The skill uses conversion formulas and assumes a trial, plan, guarantee, or refund
([conversion rules](https://github.com/elayadesign/ai-design-skills/blob/1c1e97cb9878e236552c772092dda7adcdddbcb2/skills/landing-page-design/SKILL.md#L85-L114)).
Its cliché list helps, but it does not replace curia's longer banned-word and banned-move lists.
Its ban on hyphens also conflicts with settled terms such as `self-hosted` and `no-build-step`.

The skill permits only four fonts, Tailwind size steps, one spacing scale, six dark backgrounds, and fixed icon sets.
It also requires a heading gradient, a glass navigation menu, slow reveal motion, and a separate tagline reveal
([visual rules](https://github.com/elayadesign/ai-design-skills/blob/1c1e97cb9878e236552c772092dda7adcdddbcb2/skills/landing-page-design/SKILL.md#L150-L295)).
These aesthetic choices conflict with the approved current page and should not override it.

The skill favors active voice and direct error text, which match STE-flavored writing.
It does not follow STE sentence limits, punctuation rules, or curia's controlled vocabulary.
The [positioning brief](../landing-page/positioning.md), [domain model](../../CONTEXT.md), and Literal style must remain authoritative.

## Fit with the living-organism experiment

The experiment can use the skill's section-by-section build order, concrete proof rule, and mobile checks.
Its `IntersectionObserver` advice can also reduce scroll work
([motion rules](https://github.com/elayadesign/ai-design-skills/blob/1c1e97cb9878e236552c772092dda7adcdddbcb2/skills/landing-page-design/SKILL.md#L267-L295)).

The skill does not cover WebGL, reactive physics, spatial typography, adaptive sound, scene transitions, or performance budgets.
It also omits reduced-motion behavior.
Its flat backgrounds, fixed fonts, fixed colors, and universal slow reveals can limit the requested experiment.
Its Tailwind and Framer Motion examples do not permit new dependencies or a build step.

Use the skill as a checklist, not as the experiment's design authority.
The ticket must keep sound off until the user enables it.
The ticket must also keep the no-build-step rule and the approved claims
([experiment constraints](https://github.com/alp82/curia/issues/363)).

## Recommendation

Do not name `landing-page-design` in the map Notes.
Do not add the upstream skill unchanged to curia's default worker set.

For the living-organism experiment, consult only these parts:

1. Use A4 for specific claims and nearby proof.
2. Use A6 to keep each change small.
3. Use B7 only for its scroll performance advice.
4. Use B8 only for active voice, sentence-case headings, and its cliché list.
5. Use B9 and B10 for accessibility, links, and metadata.

Ignore the fixed funnel, fonts, palette, spacing, navigation, CTA, and mandatory tagline section.
Reject B8's instruction to invent names or figures.
If curia later adopts the skill, make a reviewed fork with a narrow trigger.
Keep its MIT notice and pin the fork to a commit.
