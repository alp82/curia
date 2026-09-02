# Releases, the stable-release index, and version selection

A Curia release is published once and never changed. Which release an installation should run is a separate fact, kept in a small signed file. This page is the reference for how a version is published, how the stable release is named, how a bad version is withdrawn, and how `curia update` picks a version. The lifecycle topics in the operator guide tell you when to update; this page tells you what "the stable release" means and where that answer comes from.

## Publication order

The release workflow, `.github/workflows/release.yml`, publishes one version in the order its parts depend on each other. Nothing is announced before what it names exists.

1. **Images first.** The four service images are built from the release commit and pushed to `ghcr.io/alp82/curia-daemon`, `curia-tmux`, `curia-dashboard`, and `curia-overseer` under the version tag. The workflow records the digest the registry returned for each image and attests its build provenance.
2. **The bundle second.** The Compose bundle is rendered against those four digests, and the release manifest is written from the bundle's checksum, the digests, and the commit. The bundle, its `.sha256` file, the digest set, the manifest, and the bootstrap script `curia-install.sh` (the same script for every release, with this version stamped in; see [The bootstrap](bootstrap.md)) are attached to the draft GitHub release that Release Please created for the version.
3. **The release third.** The draft release is published. Publishing creates the `v<version>` tag and, with immutable releases enabled on the repository, locks the assets and records a release attestation.
4. **The package last.** The manifest is copied into the package as `manifest.json`, and `@curia-sh/cli@<version>` is published to npm through trusted publishing, which records provenance. By then every artifact the package names is already available.

The publication is gated at each step by `deploy/release/publish.mjs`, which asks whether the identity about to be published already exists:

| The identity exists | What the workflow does |
|---|---|
| Not yet | Publishes it. |
| With the same bytes | Keeps it and says so. A rerun of the workflow after a failed step finishes the publication instead of starting a second one. |
| With different bytes | Refuses, and the run fails. A published version tag, release asset, or package version is never replaced. Publish the next version. |

For an image, "the same bytes" means the tag already points at a digest that the release workflow attested at this commit; that digest is reused as it is. For a release asset, the published bytes are downloaded and compared. For the package, the registry's recorded integrity is compared with the tarball the workflow packed.

The version tags on images exist for browsing. The bundle and the manifest name images by digest, and nothing an installation runs reads a tag.

A rehearsal of the workflow (`workflow_dispatch` on any branch) pushes images under a commit tag, renders the bundle and manifest against their real digests, and publishes nothing: no release, no package.

## The stable-release index

Publishing a version doesn't recommend it. The recommendation lives in one file, the stable-release index, at `release/stable.json` on the `main` branch of `alp82/curia`. Installations read it from `https://raw.githubusercontent.com/alp82/curia/main/release/stable.json`.

The index holds five fields and nothing else:

| Field | What it says |
|---|---|
| `format` | The index format, `1`. |
| `sequence` | A counter that rises by one on every change. An installation that remembers the last sequence it accepted can refuse an older index. |
| `updated` | When the index last changed, as a UTC timestamp. |
| `stable` | The recommended stable release, such as `1.2.3`, or `null` when no release is recommended. It is never a prerelease and never a withdrawn version. |
| `withdrawn` | The versions marked known-bad, sorted. |

The file is a signed envelope: the index, and an Ed25519 signature over the index's canonical text. The following example shows the shape.

```json
{
  "index": {
    "format": 1,
    "sequence": 4,
    "updated": "2026-09-02T10:00:00Z",
    "stable": "1.2.3",
    "withdrawn": [
      "1.2.2"
    ]
  },
  "signature": {
    "algorithm": "ed25519",
    "key": "…16 hex characters…",
    "value": "…base64…"
  }
}
```

The index names versions. It never describes one: what a version is made of is the release manifest, as [The release manifest and release verification](release-manifest.md) describes.

### How the signature is verified

The public key ships inside `@curia-sh/cli` as `stable-index.pub`, so an installed version holds it at `versions/<version>/cli/stable-index.pub`. When Curia downloads the index, it checks that the signature names the same key the installed version pins, then verifies the signature with that key. The private key exists only as the repository secret `CURIA_STABLE_INDEX_KEY`, which the promotion workflow reads. No key is fetched from the network, and no other tool is needed on the host.

Trust flows from the package: Curia verified the package against the npm registry's integrity value and the release manifest before it activated the version, and the key the package carries is the key the index must be signed with.

An index that doesn't download, has no signature, names another key, or doesn't verify is a failed check. Curia reports the reason and selects nothing from it. It never falls back to an unsigned file.

To read the index yourself:

```sh
curl -fsSL https://raw.githubusercontent.com/alp82/curia/main/release/stable.json
```

## Promotion

Promotion names a published version as the stable release. It changes the index and nothing else: no image is rebuilt, no asset is replaced, no package is republished. The artifacts a promotion recommends are the artifacts that were rehearsed.

To promote a version, run the `Stable-release index` workflow (`.github/workflows/stable-index.yml`) with `action` set to `promote` and the version. From the command line:

```sh
gh workflow run stable-index.yml --repo alp82/curia -f action=promote -f version=1.2.3
```

The workflow:

1. Downloads the published package, bundle, and checksum and runs the same six checks `curia install` runs, so a promotion never names a version that would refuse to install.
2. Applies the promotion to the current index and signs the result.
3. Commits `release/stable.json` to `main` as `chore(release): promote 1.2.3 as the stable release`.

A promotion refuses a prerelease, a withdrawn version, or a version whose published artifacts don't verify. Promoting the version that is already stable changes nothing.

## Withdrawal

Withdrawal marks a version known-bad. After it, `curia update` doesn't select the version automatically and refuses an exact request for it. The artifacts stay published: the release, the images, and the package remain where they are, for the record and for an installation that still runs the version.

To withdraw a version:

```sh
gh workflow run stable-index.yml --repo alp82/curia -f action=withdraw -f version=1.2.2
```

Withdrawing the current stable release clears `stable`. Until the next promotion, `curia update` without a version reports that no stable release is recommended. Promote the fixed version first when you can, and withdraw the bad one second, so the gap never opens.

Write the reason on the GitHub release of the withdrawn version. The refusal an operator sees points at that page.

## How `curia update` selects a version

`curia update` reads the index, verifies it, and applies one rule:

| Command | What is selected |
|---|---|
| `curia update` | The `stable` release named in the index. When `stable` is `null`, the command refuses and says no stable release is recommended right now. |
| `curia update 1.2.4` | Exactly `1.2.4`, whether or not it is the stable release. The version must still verify against its release manifest before it is activated. |
| `curia update --prerelease 1.3.0-rc.1` | Exactly that prerelease. Without `--prerelease`, a prerelease version is refused, so nobody installs one by accident. |

A withdrawn version is refused in every form. A version that isn't a release version, such as `latest` or `v1.2.3`, is refused before anything is looked up.

A prerelease is a version with a hyphenated suffix, such as `1.3.0-rc.1`. Prereleases are published the same way as releases and verified the same way, and they are never the stable release. The `--prerelease` path is for rehearsing a candidate on a disposable host before it is promoted.

The Curia service checks the index once a day and the Curia app shows the installed version, the recommended version, and a warning when the installed version was withdrawn. Discovery never changes the running installation, and a failed check leaves it as it is.

## The signing key

The key is made once, by a person with administrator access to `alp82/curia` and `gh` logged in:

```sh
node deploy/release/keygen.mjs
```

The command generates an Ed25519 pair, sets the private key as the repository secret `CURIA_STABLE_INDEX_KEY` over standard input, and writes the public key to `cli/stable-index.pub`. Commit that file. The private key is never written to disk or printed.

The release workflow refuses to publish a version whose package pins no key, or pins a key the secret doesn't match, because such a version could never select an update.

To rotate the key, run `keygen.mjs --rotate`, commit the new public key, and publish a version. An installed version verifies the index with the key it carries, so keep signing with the old key until every installation you care about runs a version that pins the new one, then switch the secret.

## One-time setup

The following steps happen once, by hand, before the first publication. Each one is a fact the workflow depends on and can't create for itself.

1. Run `node deploy/release/keygen.mjs` and commit `cli/stable-index.pub`.
2. Publish `@curia-sh/cli` once by hand with `npm publish --access public` from `cli/`, because npm's trusted publisher can be configured only on a package that exists. Then, on npmjs.com, add a trusted publisher for the package: repository `alp82/curia`, workflow `release.yml`, environment `release`. After the first workflow publish works, set the package's publishing access to require two-factor authentication and disallow tokens, and revoke any token used for the manual publish.
3. Create the `release` environment in the repository settings. Add a required reviewer if you want a person to approve each publication and promotion; without one, the environment gates nothing and the workflow runs through.
4. Enable immutable releases in the repository settings, so a published release locks its tag and assets.
5. After the first workflow run, make the four GHCR packages public in their package settings, so an anonymous `docker pull` works.
6. Keep `CURIA_RELEASE_APP_CLIENT_ID` and `CURIA_RELEASE_APP_PRIVATE_KEY` as they are: the Curia GitHub App drafts the release and commits the index.
