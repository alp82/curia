# Trusted npm and container distribution constraints

Evidence for [Establish trusted npm and container distribution constraints](https://github.com/alp82/curia/issues/849).
This research checked official sources on August 30, 2026.

## Answer

Publish `@curia-sh/cli`, the Compose bundle, and the container images from one protected GitHub Actions release workflow.
Build one version manifest that binds a Curia version to the Compose bundle SHA-256 and every container digest.
Embed that manifest in the npm package.

Publish in dependency order:

1. Push each public GitHub Container Registry (GHCR) image and record its digest.
2. Generate the Compose bundle with digest-pinned image references.
3. Attach the bundle and checksum manifest to a draft GitHub release, then publish it as an immutable release.
4. Publish the npm package last, after every artifact that it installs is available.

The CLI must download the exact release asset, verify its SHA-256 against its embedded manifest before extraction, and validate the Compose image references.
Compose must pull images by digest.
This chain gives the normal install deterministic content verification without adding Cosign as a host dependency.

Generate provenance for all three surfaces, but don't describe provenance as a malware or quality guarantee.
It proves which identity and workflow produced an artifact.
GitHub and npm both state that an attestation has value only when a consumer verifies it ([GitHub artifact attestations](https://docs.github.com/en/actions/concepts/security/artifact-attestations), [npm provenance](https://docs.npmjs.com/generating-provenance-statements/)).

## npm package constraints

Use npm trusted publishing rather than an automation token.
Trusted publishing exchanges a GitHub Actions OpenID Connect (OIDC) identity for a short-lived publish credential.
For GitHub Actions, it requires a GitHub-hosted runner, Node 22.14.0 or later, npm 11.5.1 or later, and `id-token: write`.
The trust configuration binds one package to one repository, workflow filename, and optional GitHub environment.
Only one trusted publisher can be active for a package ([npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)).

After the trusted publisher works, set npm publishing access to **Require two-factor authentication and disallow tokens** and revoke old automation tokens.
This setting doesn't block the OIDC publisher.
If Curia later needs approval at npm itself, stage-only trusted publishing adds a two-factor-authenticated approval before public availability ([npm trusted publishing security settings](https://docs.npmjs.com/trusted-publishers/#recommended-restrict-token-access-when-using-trusted-publishers)).

The first package release is a special bootstrap operation.
`npm trust` requires the package to exist and requires npm 11.15.0 or later, package write access, and account-level two-factor authentication.
Create `@curia-sh/cli` with one controlled manual public publish, configure its trusted publisher, test OIDC publishing, and then disable token publishing ([`npm trust` prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust/#prerequisites)).

Keep Curia public to retain automatic npm provenance.
Trusted publishing generates provenance automatically only when the repository and package are public.
The package's `repository.url` must match the GitHub repository exactly ([npm trusted publishing limitations](https://docs.npmjs.com/trusted-publishers/#automatic-provenance-generation)).
A scoped package also needs `--access public` on its first publish ([publishing scoped public packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/)).

npm supplies package transport integrity, but it doesn't close the complete bootstrap trust problem.
The registry records SHA-1 and SHA-512 integrity values at publication, and later installs use the strongest supported hash.
A published name and version can't be reused ([`npm publish`](https://docs.npmjs.com/cli/v10/commands/npm-publish/#description)).
`npm audit signatures` can verify registry signatures and provenance for an installed dependency tree ([npm audit signatures](https://docs.npmjs.com/cli/audit/#audit-signatures)).
However, a one-shot `npx` command has already downloaded and started the CLI before the CLI can verify itself.

The canonical installation guide should therefore show an exact release, such as:

```sh
npx @curia-sh/cli@1.2.3 install
```

An exact npm version is immutable.
An unversioned command resolves through the mutable `latest` distribution tag, so it is the convenience path rather than the strongest reproducible path ([npm package specifications](https://docs.npmjs.com/cli/v10/commands/npm-publish/#description)).

## GitHub release workflow constraints

Put publication behind a GitHub `release` environment.
An environment can require a reviewer, prevent self-review, restrict deployment branches and tags, and withhold its secrets until approval.
It can also disable administrator bypass ([GitHub deployment environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)).
Bind npm's trusted publisher to the same environment so the environment gates the OIDC identity, not only stored secrets.

Grant each job only the permissions that it needs.
The container and attestation job needs `contents: read`, `packages: write`, `attestations: write`, and `id-token: write`.
Pin every referenced action to a full commit SHA.
GitHub identifies a full commit SHA as the only immutable way to consume an action ([GitHub Actions secure use reference](https://docs.github.com/en/actions/reference/security/secure-use)).

Enable immutable GitHub releases.
After publication, GitHub locks the release assets and tag and creates a release attestation over the tag, commit, and assets.
Prepare the release as a draft, attach every asset, and then publish it ([GitHub immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)).
An operator can verify the release and downloaded bundle with `gh release verify` and `gh release verify-asset` ([GitHub release verification](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/verify-release-integrity)).

Checksums alone detect changed bytes only when the expected checksum comes through a trusted channel.
For Curia, the immutable npm package carries the expected Compose bundle SHA-256.
The immutable GitHub release and its release attestation provide an independent check.

## Container and Compose constraints

Publish GHCR images from GitHub Actions with the repository's `GITHUB_TOKEN` and `packages: write`, not a personal access token.
Add the `org.opencontainers.image.source` label so GHCR connects each package to the source repository.
GHCR packages use private visibility by default, so make every Curia image public before relying on anonymous installation pulls ([GitHub Container Registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)).

Generate an artifact attestation for each pushed image digest.
GitHub's documented workflow gives the attestation job `attestations: write` and `id-token: write`, then passes the fully qualified image name, build output digest, and `push-to-registry: true` to `actions/attest` ([publishing and attesting container images](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images)).
For a public repository, GitHub uses Sigstore's public instance and records the bundle in a public transparency log ([GitHub artifact attestations](https://docs.github.com/en/actions/concepts/security/artifact-attestations)).

Use a digest in every Compose `image` value:

```yaml
services:
  daemon:
    image: ghcr.io/alp82/curia-daemon@sha256:<digest>
```

Compose accepts `image@sha256:<digest>`.
Its default `missing` pull policy pulls an absent image and reuses an exact cached image.
GitHub recommends digest pulls when you must always use the same GHCR image ([Compose service images](https://docs.docker.com/reference/compose-file/services/#image), [GHCR digest pulls](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry#pulling-container-images)).
Version tags can remain for discovery, but the released Compose bundle must not rely on them.

Release automation can use `docker compose config --resolve-image-digests` or `--lock-image-digests` to resolve tags.
Store the resulting exact digest set in the generated release bundle and version manifest, then test the generated bundle before publication ([`docker compose config`](https://docs.docker.com/reference/cli/docker/compose/config/)).
Pin and test a minimum Docker Compose CLI version based on the fields and commands that the release uses.

## Verification boundary

Normal installation should enforce these checks without a separate verification binary:

- npm verifies the package tarball against registry integrity metadata.
- The package verifies the downloaded Compose bundle against its embedded SHA-256.
- The package confirms that every Compose image matches its embedded digest manifest.
- Docker pulls those exact content digests.

Add a full provenance check to `curia doctor --verify-release` and document the equivalent manual commands.
GitHub CLI can verify a local bundle or an OCI image and constrain the repository, signer workflow, source digest, and source ref.
For an OCI image, use its fully qualified `oci://` URI and the exact signer workflow ([`gh attestation verify`](https://cli.github.com/manual/gh_attestation_verify)).

Cosign can also verify an image or blob by certificate identity and OIDC issuer.
Image signatures bind the image digest, while blob verification uses a separate Sigstore bundle ([Cosign verification](https://docs.sigstore.dev/cosign/verifying/verify/), [Cosign blob signing](https://docs.sigstore.dev/cosign/signing/signing_with_blobs/)).
Don't require a standalone Cosign installation for normal onboarding.
GitHub attestations already use Sigstore, and Curia's required GitHub CLI can expose the complete provenance check after GitHub authentication.

## Decisions this research leaves open

- Whether every release requires a human environment approval or only protected release tags and automated checks.
- Whether full provenance verification blocks the first container start or remains a `doctor` check after GitHub authentication.
- Whether npm staged publishing adds enough protection to justify its manual two-factor-authenticated approval.
