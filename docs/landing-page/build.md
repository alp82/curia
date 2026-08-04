# Landing page: build path, source directory, preview

**Settled**: 2026-08-02, in [Choose the page's build path and source directory](https://github.com/alp82/curia/issues/111),
on the map [The curia landing page](https://github.com/alp82/curia/issues/109).
Every answer below came from the operator over Discord escalations.

This file is the contract the shipping tickets build against. It fixes where the page lives, what
turns it into a site, and the one command an agent runs before `publish_preview`.

## Build path: none

**Hand-written HTML and CSS, committed. No generator, no GitHub Actions, no build step at all.**

The whole site is one page. A generator would add a toolchain, a lockfile and a CI workflow to this
repo — which today has no root `package.json` and no `.github/` — to produce a file a person can
write directly. The repo's own daemon runs unbuilt; the page matches it.

`docs/` is served as it sits in `main`. Push and it is live.

## Source directory: `docs/`, served from `main`

GitHub Pages publishes from a branch, source `main` **`/docs`**.

**Why `/docs` and not a `landing-page/` subfolder.** Branch publishing offers exactly two folders —
the repository root or `/docs`
([GitHub docs](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)).
There is no third choice. Serving an arbitrary subfolder needs a GitHub Actions workflow to upload it
as an artifact, and that workflow was the only thing standing between this map and a zero-build ship.

The layout:

```
docs/
  index.html      the page — https://curia.sh/
  .nojekyll       serve the tree as-is, no Jekyll build
  CNAME           the custom domain, written by GitHub when it was set in repo settings
  adr/ agents/ research/ live-checks/ deploy.md   the repo's own docs, unchanged
```

**Known and accepted: everything under `docs/` becomes part of the site.** `docs/adr/0001-....md`
is reachable at `https://curia.sh/adr/0001-....md` as raw markdown. The repo is public, so
those files were already readable on GitHub — Pages changes the URL they answer on, not who can read
them. Nothing secret lives here. Anything that must not be published does not go in `docs/`.

`.nojekyll` is required, not decoration. Without it Pages runs Jekyll over the whole folder, and a
Liquid-looking `{{ ... }}` in any committed markdown fails the build.

## Local preview

One command, from the repo root:

```
python3 -m http.server 4000 --directory docs
```

Then `publish_preview(4000, "/")`.

`/` is the page locally and `/` is the page live, so an agent previews the same URL shape that
ships. No path skew between the review gate and production.

**Why `http.server` and not a node dev server:**

- **No install, no network, no `package.json`.** python3 is on the box. A node static server means
  `npx serve`, which downloads on first run, and this repo has no root `package.json` to hang it off.
- **No host check.** Tailscale Serve passes the original `Host` header through, and Vite's host check
  answers `*.ts.net` with `Blocked request` — the repair recorded in
  [`docs/full-loop.md`](../full-loop.md) cost an `allowedHosts` line in every watched repo.
  `http.server` has no host check, so a preview here cannot hit that class of bug.
- **About 10 MB**, against the ~0.3 GB per preview dev server that `config/curia.yaml` budgets.

**Port 4000**, checked free on the host. It is clear of the daemon (4271, 4272), ttyd (7681), the
attach and timeline Serve rules (8443, 8444) and the 8500–8599 preview range. `8000` and `8080` were
both taken.

**If the port is busy, move up.** `dispatch.max_concurrent` is 6, so two agents can want a preview
at the same moment and `http.server` exits on `Address already in use`. Try 4001, 4002, and pass the
port you **actually** bound — which is why `publish_preview` takes a port rather than reading a
configured one (#40).

## One source of truth: not wanted

Asked whether the page, `README.md` and the self-host guide should render from one file, the operator
ruled against it: they cover similar ground in their own voice, for different readers, and a build
step to keep three copies identical would buy a sameness nobody asked for.

So:

- **The page** carries its own version of the setup steps, written for a stranger who has not cloned
  the repo.
- **[`README.md`](../../README.md)** keeps its own job — orienting someone reading the code. It must
  stop *contradicting* the page ([Bring the README into line with the page](https://github.com/alp82/curia/issues/117));
  it does not have to repeat it.
- **The self-host guide** from [Write the self-host guide](https://github.com/alp82/curia/issues/112)
  stays as markdown in the repo, as the repo-side document. Nothing renders it into the page.

Agreement is on framing — who curia is for, what state it is in. Not on wording.

## What this hands the next tickets

- [Provision GitHub Pages and fix the public URL](https://github.com/alp82/curia/issues/113):
  **answered** — the site is live at `https://curia.sh`, served from branch `main` folder `/docs`,
  with HTTPS enforced. The URL, the DNS records and how to verify them are in
  [`pages.md`](pages.md).
- [Prototype the landing page](https://github.com/alp82/curia/issues/115) and every later build
  ticket: write `docs/index.html` and any CSS beside it, preview with the command above.

`docs/index.html` is a placeholder today — enough for the pipeline to serve a 200. The prototype
replaces it whole.
