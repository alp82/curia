# Landing page: the public URL and the Pages source

**Settled**: 2026-08-02, in [Provision GitHub Pages and fix the public URL](https://github.com/alp82/curia/issues/113),
on the map [The curia landing page](https://github.com/alp82/curia/issues/109).
The URL was the operator's call; the DNS and repo-settings work was the operator's to run, from the
checklist below.

This file records what is live and how to get back to it. It is the companion to
[`build.md`](build.md), which fixes what gets built and where it lives.

## The URL

**`https://curia.sh`** — apex, custom domain.

`www.curia.sh` redirects to it.

The alternative was the project page, `alp82.github.io/curia`. It ships without touching a
registrar, but the page would sit under a `/curia/` subpath forever — every link and asset in
`index.html` prefixed or relative — and the URL reads as a repository, not a product. The domain was
already registered (Namecheap, 2026-07-25), so the only cost of the custom domain was the DNS work
below, done once.

The apex is the canonical URL. Write links to `https://curia.sh`, never to
`alp82.github.io/curia` — that host still answers, but it 301s to the custom domain once the domain
is set, and hard-coding it means the page stops being portable off GitHub.

## The Pages source

| | |
| --- | --- |
| Source | Deploy from a branch |
| Branch | `main` |
| Folder | `/docs` |
| Build | none — served as committed ([`build.md`](build.md)) |
| Custom domain | `curia.sh` |
| Enforce HTTPS | on |

Setting the custom domain in repo settings makes GitHub commit a `CNAME` file to the publishing
source on `main`. **That file is load-bearing** — deleting it drops the custom domain and the site
falls back to `alp82.github.io/curia`. It was written by GitHub, not by a worker; leave it where it
sits.

## The DNS records

At Namecheap, `curia.sh` → Advanced DNS. The parking records that shipped with the registration —
an A record on `@` pointing at `192.64.119.209`, and the `www` parking entry — were deleted first.

Four **A** records, Host `@`:

```
185.199.108.153
185.199.109.153
185.199.110.153
185.199.111.153
```

Four **AAAA** records, Host `@`:

```
2606:50c0:8000::153
2606:50c0:8001::153
2606:50c0:8002::153
2606:50c0:8003::153
```

One **CNAME**, Host `www`, value `alp82.github.io.`

All four A records and all four AAAA records are required — GitHub serves Pages from that whole set,
and a partial set gives an intermittently reachable site rather than an obviously broken one, which
is worse. The addresses are GitHub's published apex set
([GitHub docs](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site));
if they ever change, that page is the source of truth, not this one.

## HTTPS

**Enforce HTTPS is on.** GitHub issued a certificate covering `curia.sh` and `www.curia.sh`, valid
to 2026-10-31 and renewed automatically. The setting stays greyed out until that certificate exists,
which is why it is the last step rather than part of the same visit to the settings page.

Enforcement does not take effect the moment it is ticked — the plain-HTTP edge keeps answering 200
for a few minutes before it starts 301ing. A `http://curia.sh` that has not flipped yet is a stale
edge, not a failed setting; check `https_enforced` on the API before believing otherwise.

## Verifying it

From any box:

```
curl -sSI https://curia.sh | head -1        # HTTP/2 200
curl -sSI http://curia.sh | head -1         # HTTP/1.1 301 -> https://curia.sh/
curl -sSI https://www.curia.sh | head -1    # HTTP/2 301 -> https://curia.sh/
dig +short A curia.sh                       # the four 185.199.x.153 addresses
gh api repos/alp82/curia/pages --jq '{cname,status,https_enforced,source}'
```

Checked 2026-08-02, all passing: `https://curia.sh/` serves 200; `www.curia.sh` and
`alp82.github.io/curia` both 301 to the apex; the API reports `status: built`, `cname: curia.sh`,
source `main` `/docs`, `https_enforced: true`.

A fresh push to `main` takes about a minute to appear. If the site 404s after a push, check that
`docs/.nojekyll` and `docs/index.html` are both still in the tree — those two files are the whole
publishing contract.

## What this hands the next tickets

- [Prototype the landing page](https://github.com/alp82/curia/issues/115) and every later build
  ticket: the page ships to `https://curia.sh`, at the root. Internal links are root-relative
  (`/foo`), not `/curia/`-prefixed.
- `docs/index.html` today carries `<meta name="robots" content="noindex">`, put there while it was a
  placeholder. **The ticket that writes the real page removes it** — the domain is live and
  indexable now, and shipping the finished page with a noindex is a silent way to publish nothing.
- Anywhere the repo names a URL for the page — `README.md`, the self-host guide, the repo's
  About/homepage field — it is `https://curia.sh`.
