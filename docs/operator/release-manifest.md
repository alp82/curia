# The release manifest and release verification

A Curia release is one version, and one file says what that version is made of. This page is the reference for that file, the release manifest, for the checks Curia runs against it before it activates a version, and for what each failed check means. The lifecycle topics in the operator guide tell you when Curia runs these checks; this page tells you what they prove.

## What the manifest binds

The release workflow writes one manifest per release, `curia-manifest-<version>.json`, and attaches it to the GitHub release. The same file ships inside the `@curia-sh/cli` package as `manifest.json`, so an installed version holds it at `versions/<version>/cli/manifest.json`. The manifest binds the following facts, and nothing else:

| Field | What it names |
|---|---|
| `format` | The manifest format, `1`. |
| `version` | The Curia version, such as `1.2.3`. It is also the npm package version and the release tag without its `v`. |
| `package` | `@curia-sh/cli` and its version, which equals `version`. |
| `bundle` | The file name of the Compose bundle archive, `curia-bundle-<version>.tar.gz`, and its SHA-256 checksum. |
| `images` | For each of the four services, `daemon`, `tmux`, `dashboard`, and `overseer`, the image name under `ghcr.io/alp82` and its exact `sha256:` digest. |
| `source` | The repository, `alp82/curia`, the full commit the release was built from, and the workflow that built and attested it, `.github/workflows/release-images.yml`. |

The following example shows the shape.

```json
{
  "format": 1,
  "version": "1.2.3",
  "package": { "name": "@curia-sh/cli", "version": "1.2.3" },
  "bundle": { "name": "curia-bundle-1.2.3.tar.gz", "sha256": "…64 hex characters…" },
  "images": {
    "daemon": { "name": "ghcr.io/alp82/curia-daemon", "digest": "sha256:…" },
    "tmux": { "name": "ghcr.io/alp82/curia-tmux", "digest": "sha256:…" },
    "dashboard": { "name": "ghcr.io/alp82/curia-dashboard", "digest": "sha256:…" },
    "overseer": { "name": "ghcr.io/alp82/curia-overseer", "digest": "sha256:…" }
  },
  "source": { "repository": "alp82/curia", "commit": "…40 hex characters…", "workflow": ".github/workflows/release-images.yml" }
}
```

Three things the manifest never holds:

- **A tag.** Every image is a digest. A version tag on an image, such as `curia-daemon:1.2.3`, exists for browsing the registry, and nothing Curia installs reads it.
- **Compatibility metadata.** The manifest identifies one release. It doesn't say which versions the release can update from or roll back to. That contract is fixed: one direct update to the latest stable release, and one retained rollback release.
- **Anything mutable.** A published manifest, bundle, image, and package are immutable. A withdrawn release stays published and is only marked withdrawn in the stable-release index.

## Where the manifest comes from

The release workflow runs on the release tag. It pushes each image, records the digest the registry returned, attests the build provenance of that digest, renders the bundle, computes the bundle's checksum, and then writes the manifest from those facts and the commit it ran on. The manifest is the last artifact the workflow writes, and it's written from the artifacts themselves, never typed in.

The workflow attaches the manifest to the GitHub release beside the bundle, the bundle's `.sha256` file, and the digest set `curia-images-<version>.json`. The publication step then copies the manifest into the npm package before `npm publish`, so the package that npm's own integrity check covers carries the expected checksum and digests of everything else the release installs.

The result is two copies that must be the same bytes: the one inside the package, which comes from the npm registry, and the one on the release, which comes from GitHub. A release whose two copies differ doesn't install.

## What Curia verifies before activation

`curia install` and `curia update` download the package tarball, the bundle archive, and the `.sha256` file, then run the following checks before they unpack anything or change the active version. Every check must pass. The command prints one line per check and stops with exit code `3` when one fails.

| Check | What it proves |
|---|---|
| manifest | The package tarball opens as an archive and carries one `manifest.json` that parses as a complete, well-formed manifest. |
| version | The manifest's version is the version you asked for, and the tarball's `package.json` names `@curia-sh/cli` at that version. |
| package integrity | The SHA-512 of the downloaded tarball equals the `sha512` integrity value the npm registry records for `@curia-sh/cli@<version>`. |
| bundle checksum | The SHA-256 of the downloaded bundle archive equals the checksum the manifest binds, and the `.sha256` file names the same checksum for the same file. |
| image digests | The archive holds exactly `curia-bundle-<version>/compose.yaml`, that file passes the bundle inspection, and its `image:` lines are exactly the four digest references the manifest binds. No tag, no other registry, no fifth image. |
| release manifest | The `curia-manifest-<version>.json` on the GitHub release parses and says the same thing as the copy inside the package. |

Nothing passes by absence. A missing tarball, archive, checksum file, or release asset fails its check. A registry that doesn't answer fails the package integrity check. Curia doesn't retry on its own and doesn't fall back to a weaker check.

After the checks pass, Curia keeps the verified artifacts as it downloaded them, so `curia doctor` can repeat the checks later:

| Path in the installation root | What it is |
|---|---|
| `versions/<version>/cli.tgz` | The package tarball, as downloaded. |
| `versions/<version>/cli/` | The unpacked package, with `manifest.json` inside. |
| `versions/<version>/bundle.tar.gz` and `.sha256` | The bundle archive and its checksum file, as downloaded. |
| `versions/<version>/bundle/compose.yaml` | The unpacked bundle, which the lifecycle interface starts. |

## What `curia doctor` verifies

`curia doctor` runs the six preceding checks again on the retained artifacts of the active version, then adds three checks that prove the installed files and the publication provenance. It's read-only.

| Check | What it proves |
|---|---|
| installed files | `cli/manifest.json` and `cli/package.json` are the files inside the retained tarball, and `bundle/compose.yaml` is the file inside the retained archive. An edited or replaced file fails. |
| image provenance | Each image digest in the manifest carries a build attestation signed by the release workflow of `alp82/curia` at the manifest's commit. Curia asks `gh attestation verify` for each digest. |
| package provenance | The npm registry records publication provenance for `@curia-sh/cli@<version>`. |

The image provenance check needs the GitHub CLI, `gh`, logged in to GitHub. When it isn't, the check fails and the message says so. Nothing else in Curia depends on that login.

To run the same provenance checks by hand, use the following commands, with the values from the manifest of the active version:

```sh
gh attestation verify oci://ghcr.io/alp82/curia-daemon@sha256:<digest> \
  --repo alp82/curia \
  --signer-workflow alp82/curia/.github/workflows/release-images.yml \
  --source-digest <commit>

gh release verify-asset v<version> curia-bundle-<version>.tar.gz --repo alp82/curia
```

For the package, `npm audit signatures` in a directory where `@curia-sh/cli@<version>` is installed verifies the registry signature and the provenance statement.

## When a check fails

A failed check names the condition and one corrective action. The following table lists the failure classes.

| Class | Example | What to do |
|---|---|---|
| Missing | The bundle archive wasn't downloaded, or the release carries no manifest asset. | Check outbound access to `registry.npmjs.org` and `github.com`, then run the command again. |
| Malformed | The tarball isn't a gzipped archive, or the manifest lacks a field or carries one that isn't part of the contract. | Download the release again. A release that fails the same way twice is damaged: don't install it, and report it. |
| Substituted | The tarball's SHA-512 doesn't match the registry, the archive's SHA-256 doesn't match the manifest, or the bundle names an image the manifest doesn't bind. | Download the release again. A release that fails the same way twice is one you shouldn't install. Report it at the repository. |
| Mismatched | The manifest is for another version than the one requested, `package.json` names another version, or the release asset manifest differs from the package copy. | Ask for the version the artifacts belong to, or download the version you asked for. Two copies of one manifest that disagree mean the release and the package were published apart: don't install it, and report it. |
| Drifted (doctor only) | An installed file differs from the retained artifact. | Run `curia reinstall` to restore the version from the release, or `curia update`. |
| Unattested (doctor only) | An image digest carries no attestation from the release workflow, or the registry records no provenance for the package. | Run the `gh attestation verify` command the message prints to see the full answer. If `gh` isn't logged in, log in and run `curia doctor` again. An image or package without provenance is a release to report. |

Curia never prints a full digest, a full integrity value, or a manifest body in a report. The first twelve characters of a checksum are enough to compare with the file on the release page.
