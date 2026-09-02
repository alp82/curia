# Changelog

## [0.9.0](https://github.com/alp82/curia/compare/v0.8.0...v0.9.0) (2026-09-02)


### Features

* name the Tailscale node from the setup card ([#940](https://github.com/alp82/curia/issues/940)) ([21b9264](https://github.com/alp82/curia/commit/21b9264288b3f5d13208302184326c569c502ffa))


### Bug Fixes

* let the operator choose the watched repositories and keep the image's watch list out of installations ([#941](https://github.com/alp82/curia/issues/941)) ([77d37f2](https://github.com/alp82/curia/commit/77d37f21940753640f30ec9947ff6da3d5e5b78c))
* serve the terminal on packaged installations and take the Anthropic code from the card ([#943](https://github.com/alp82/curia/issues/943)) ([d976417](https://github.com/alp82/curia/commit/d976417267247d87e5645a9354b5d99c369b6476))
* show sign-in progress before errors, copy the code, and keep the routing preset valid with one provider ([#942](https://github.com/alp82/curia/issues/942)) ([08cd7f0](https://github.com/alp82/curia/commit/08cd7f0b246c7aaaed1ef8bda3d4a7030618419d))
* wait for the Discord bot to join a server before asking for the channel ([#939](https://github.com/alp82/curia/issues/939)) ([8d05665](https://github.com/alp82/curia/commit/8d05665987cacda56df2e8b241721e59f157dccc))

## [0.8.0](https://github.com/alp82/curia/compare/v0.7.0...v0.8.0) (2026-09-02)


### Features

* automate semantic Curia releases ([77be7b3](https://github.com/alp82/curia/commit/77be7b3d0e8a9881a65b271125f085ee0b60f46f))
* bind and verify every release artifact with one manifest ([#901](https://github.com/alp82/curia/issues/901)) ([e7b5d5d](https://github.com/alp82/curia/commit/e7b5d5dd17ab4acc118625c16d4414602bba4b7c))
* bootstrap the verified lifecycle interface with Bash ([#903](https://github.com/alp82/curia/issues/903)) ([e917948](https://github.com/alp82/curia/commit/e917948034b6f7395cf6e4662b7cbe0d4b19853e))
* build immutable service images and the versioned Compose bundle ([#900](https://github.com/alp82/curia/issues/900)) ([3e5c186](https://github.com/alp82/curia/commit/3e5c1866eed819d31110ad53054e1b1b6fc52ef6))
* build the resumable browser integration frame ([#905](https://github.com/alp82/curia/issues/905)) ([603238e](https://github.com/alp82/curia/commit/603238e06640a62a9c8b84f03cda5b2b3790dde8))
* connect and verify Anthropic during integration setup ([#910](https://github.com/alp82/curia/issues/910)) ([a6086f1](https://github.com/alp82/curia/commit/a6086f1119b99448be4a7757fd6c1579aaeb8350))
* connect and verify Discord during integration setup ([#907](https://github.com/alp82/curia/issues/907)) ([9ec45a9](https://github.com/alp82/curia/commit/9ec45a99af66b1002bf89add5a1dd490e3345ea8))
* connect and verify GitHub during integration setup ([#906](https://github.com/alp82/curia/issues/906)) ([ec9bae9](https://github.com/alp82/curia/commit/ec9bae9378d4f278d2eac4375fb70848b49de6b3))
* connect and verify OpenAI during integration setup ([#909](https://github.com/alp82/curia/issues/909)) ([df4859b](https://github.com/alp82/curia/commit/df4859b4561dc4165eaa255049138cfc7989f35c))
* connect and verify Tailscale during integration setup ([#908](https://github.com/alp82/curia/issues/908)) ([65bc1e2](https://github.com/alp82/curia/commit/65bc1e24d2ee9995b550b9e2b696d1472d0d3525))
* converge verified integrations on the Full-loop gate ([#911](https://github.com/alp82/curia/issues/911)) ([a2883c1](https://github.com/alp82/curia/commit/a2883c10c7ea6cb690a96623bfbb70ca989a4b0c))
* create and start tickets from chats ([2be7665](https://github.com/alp82/curia/commit/2be76653451ee4f5f4dd63c7b84d46735d79c293))
* discover and stage a stable Curia update ([#914](https://github.com/alp82/curia/issues/914)) ([4c8def8](https://github.com/alp82/curia/commit/4c8def873a656588ce95e8dc939eefa2ab83d7e3))
* implement supported-host preflight checks ([#899](https://github.com/alp82/curia/issues/899)) ([643935f](https://github.com/alp82/curia/commit/643935f0288e0ad32754dadd448da7f18573be22))
* install and start packaged Curia from a clean host ([#904](https://github.com/alp82/curia/issues/904)) ([8a2e428](https://github.com/alp82/curia/commit/8a2e428cb87128957e1d824a16089d05226c5084))
* integrate the canonical operator lifecycle guide ([#919](https://github.com/alp82/curia/issues/919)) ([414389c](https://github.com/alp82/curia/commit/414389cd03815ce955ce29458b04ff927564164a))
* join the tailnet during installation and name the node up front ([#934](https://github.com/alp82/curia/issues/934)) ([b6c293b](https://github.com/alp82/curia/commit/b6c293bd495413f07daa014d43150dfbeccfdb57))
* make one real Full loop the installation acceptance ([#913](https://github.com/alp82/curia/issues/913)) ([306a96a](https://github.com/alp82/curia/commit/306a96aa0bf4212daa0ecc7bf40415fcce96fa2e))
* place secrets and mutable service data behind narrow mounts ([#898](https://github.com/alp82/curia/issues/898)) ([aa8ae57](https://github.com/alp82/curia/commit/aa8ae5762a7c554cfef5f167807871d5ca546a5c))
* publish releases in order and select the stable release from a signed index ([#902](https://github.com/alp82/curia/issues/902)) ([747b3e5](https://github.com/alp82/curia/commit/747b3e5d490faa8c2d0e783f89d598542ffeaaf6))
* rename Atlas to Curia app ([#843](https://github.com/alp82/curia/issues/843)) ([1d26971](https://github.com/alp82/curia/commit/1d26971fca26aa43e8caf86db401b7d0f9d9ea47))
* roll back one failed or operator-selected release ([#916](https://github.com/alp82/curia/issues/916)) ([0988a06](https://github.com/alp82/curia/commit/0988a06f72f75e4894bbd92f9949ef7aee3ee022))
* ship redacted direct diagnostics through curia doctor ([#912](https://github.com/alp82/curia/issues/912)) ([86578d2](https://github.com/alp82/curia/commit/86578d2f51ab99c94484bed994b23bc1f8585bc3))
* ship the agent image as the fifth release image ([#935](https://github.com/alp82/curia/issues/935)) ([e905034](https://github.com/alp82/curia/commit/e9050346e341d7fac95738ba2c4e6fcbc04b4593))
* switch a live installation and re-adopt running sessions ([#915](https://github.com/alp82/curia/issues/915)) ([c067507](https://github.com/alp82/curia/commit/c0675072a6ec3d587db1b540fdf5ee5043d605e9))
* uninstall and reinstall while preserving installation identity ([#917](https://github.com/alp82/curia/issues/917)) ([d06fade](https://github.com/alp82/curia/commit/d06fade490f58deb281f6bdd5bd8504966841e6f))
* validate operator configuration through one atomic boundary ([#897](https://github.com/alp82/curia/issues/897)) ([9cabb5c](https://github.com/alp82/curia/commit/9cabb5c449292fee88758f684f89a2170511ef20))
* write and dry-run the one-time source cutover runbook ([#920](https://github.com/alp82/curia/issues/920)) ([948b5c0](https://github.com/alp82/curia/commit/948b5c0286aaae2c54117081546fee812f7577fc))


### Bug Fixes

* inject the tailscale runner in every lifecycle test and run both suites in CI ([#937](https://github.com/alp82/curia/issues/937)) ([51e2994](https://github.com/alp82/curia/commit/51e2994b4ce205ea885be481830526255f9e8bf5))
* keep typed setup fields across refreshes and quiet the app's loopback health probe ([#932](https://github.com/alp82/curia/issues/932)) ([cab82f4](https://github.com/alp82/curia/commit/cab82f47591b124e38fda283998995ca8f3f2abb))
* open setup's own routes before the first operator and prove admission over loopback ([#931](https://github.com/alp82/curia/issues/931)) ([8940032](https://github.com/alp82/curia/commit/8940032b91b38effc789105b75f1b46ccaa42da5))
* pack the package into an absolute destination during publication ([#924](https://github.com/alp82/curia/issues/924)) ([9721441](https://github.com/alp82/curia/commit/97214418c5d51b1d0dad0669102ee0517c0c488f))
* parse styled aistack device login output ([70842d1](https://github.com/alp82/curia/commit/70842d1c7c21869020ff58df5c4b0cda7068697c))
* remove terminal styling from error messages and improve session detection ([e950b73](https://github.com/alp82/curia/commit/e950b7302b983e5f9a7fd07c894e29bc01c320bb))
* send the served origin as the GitHub App manifest url from setup ([#933](https://github.com/alp82/curia/issues/933)) ([8fb1d78](https://github.com/alp82/curia/commit/8fb1d782808702986a8725e73fc2581c0ff17819))
* stop misreporting overseer reads as refusals ([95e43b7](https://github.com/alp82/curia/commit/95e43b7c42420e5e31efd1843dcb5318e90f3664))
* wait for the registry to serve a published tarball before verification ([#926](https://github.com/alp82/curia/issues/926)) ([8bc9d1c](https://github.com/alp82/curia/commit/8bc9d1cf9b072a6d29fa8815d373b24728933465))
* write a real env file for the bundle proof in the release workflow ([#922](https://github.com/alp82/curia/issues/922)) ([27f6596](https://github.com/alp82/curia/commit/27f659699bfedc58a20aeab548b7d893f4e8f14f))

## [0.7.0](https://github.com/alp82/curia/compare/v0.6.2...v0.7.0) (2026-09-02)


### Features

* join the tailnet during installation and name the node up front ([#934](https://github.com/alp82/curia/issues/934)) ([b6c293b](https://github.com/alp82/curia/commit/b6c293bd495413f07daa014d43150dfbeccfdb57))
* ship the agent image as the fifth release image ([#935](https://github.com/alp82/curia/issues/935)) ([e905034](https://github.com/alp82/curia/commit/e9050346e341d7fac95738ba2c4e6fcbc04b4593))


### Bug Fixes

* keep typed setup fields across refreshes and quiet the app's loopback health probe ([#932](https://github.com/alp82/curia/issues/932)) ([cab82f4](https://github.com/alp82/curia/commit/cab82f47591b124e38fda283998995ca8f3f2abb))
* open setup's own routes before the first operator and prove admission over loopback ([#931](https://github.com/alp82/curia/issues/931)) ([8940032](https://github.com/alp82/curia/commit/8940032b91b38effc789105b75f1b46ccaa42da5))
* send the served origin as the GitHub App manifest url from setup ([#933](https://github.com/alp82/curia/issues/933)) ([8fb1d78](https://github.com/alp82/curia/commit/8fb1d782808702986a8725e73fc2581c0ff17819))

## [0.6.2](https://github.com/alp82/curia/compare/v0.6.1...v0.6.2) (2026-09-02)


### Bug Fixes

* wait for the registry to serve a published tarball before verification ([#926](https://github.com/alp82/curia/issues/926)) ([8bc9d1c](https://github.com/alp82/curia/commit/8bc9d1cf9b072a6d29fa8815d373b24728933465))

## [0.6.1](https://github.com/alp82/curia/compare/v0.6.0...v0.6.1) (2026-09-02)


### Bug Fixes

* pack the package into an absolute destination during publication ([#924](https://github.com/alp82/curia/issues/924)) ([9721441](https://github.com/alp82/curia/commit/97214418c5d51b1d0dad0669102ee0517c0c488f))

## [0.6.0](https://github.com/alp82/curia/compare/v0.5.0...v0.6.0) (2026-09-02)


### Features

* automate semantic Curia releases ([77be7b3](https://github.com/alp82/curia/commit/77be7b3d0e8a9881a65b271125f085ee0b60f46f))
* bind and verify every release artifact with one manifest ([#901](https://github.com/alp82/curia/issues/901)) ([e7b5d5d](https://github.com/alp82/curia/commit/e7b5d5dd17ab4acc118625c16d4414602bba4b7c))
* bootstrap the verified lifecycle interface with Bash ([#903](https://github.com/alp82/curia/issues/903)) ([e917948](https://github.com/alp82/curia/commit/e917948034b6f7395cf6e4662b7cbe0d4b19853e))
* build immutable service images and the versioned Compose bundle ([#900](https://github.com/alp82/curia/issues/900)) ([3e5c186](https://github.com/alp82/curia/commit/3e5c1866eed819d31110ad53054e1b1b6fc52ef6))
* build the resumable browser integration frame ([#905](https://github.com/alp82/curia/issues/905)) ([603238e](https://github.com/alp82/curia/commit/603238e06640a62a9c8b84f03cda5b2b3790dde8))
* connect and verify Anthropic during integration setup ([#910](https://github.com/alp82/curia/issues/910)) ([a6086f1](https://github.com/alp82/curia/commit/a6086f1119b99448be4a7757fd6c1579aaeb8350))
* connect and verify Discord during integration setup ([#907](https://github.com/alp82/curia/issues/907)) ([9ec45a9](https://github.com/alp82/curia/commit/9ec45a99af66b1002bf89add5a1dd490e3345ea8))
* connect and verify GitHub during integration setup ([#906](https://github.com/alp82/curia/issues/906)) ([ec9bae9](https://github.com/alp82/curia/commit/ec9bae9378d4f278d2eac4375fb70848b49de6b3))
* connect and verify OpenAI during integration setup ([#909](https://github.com/alp82/curia/issues/909)) ([df4859b](https://github.com/alp82/curia/commit/df4859b4561dc4165eaa255049138cfc7989f35c))
* connect and verify Tailscale during integration setup ([#908](https://github.com/alp82/curia/issues/908)) ([65bc1e2](https://github.com/alp82/curia/commit/65bc1e24d2ee9995b550b9e2b696d1472d0d3525))
* converge verified integrations on the Full-loop gate ([#911](https://github.com/alp82/curia/issues/911)) ([a2883c1](https://github.com/alp82/curia/commit/a2883c10c7ea6cb690a96623bfbb70ca989a4b0c))
* create and start tickets from chats ([2be7665](https://github.com/alp82/curia/commit/2be76653451ee4f5f4dd63c7b84d46735d79c293))
* discover and stage a stable Curia update ([#914](https://github.com/alp82/curia/issues/914)) ([4c8def8](https://github.com/alp82/curia/commit/4c8def873a656588ce95e8dc939eefa2ab83d7e3))
* implement supported-host preflight checks ([#899](https://github.com/alp82/curia/issues/899)) ([643935f](https://github.com/alp82/curia/commit/643935f0288e0ad32754dadd448da7f18573be22))
* install and start packaged Curia from a clean host ([#904](https://github.com/alp82/curia/issues/904)) ([8a2e428](https://github.com/alp82/curia/commit/8a2e428cb87128957e1d824a16089d05226c5084))
* integrate the canonical operator lifecycle guide ([#919](https://github.com/alp82/curia/issues/919)) ([414389c](https://github.com/alp82/curia/commit/414389cd03815ce955ce29458b04ff927564164a))
* make one real Full loop the installation acceptance ([#913](https://github.com/alp82/curia/issues/913)) ([306a96a](https://github.com/alp82/curia/commit/306a96aa0bf4212daa0ecc7bf40415fcce96fa2e))
* place secrets and mutable service data behind narrow mounts ([#898](https://github.com/alp82/curia/issues/898)) ([aa8ae57](https://github.com/alp82/curia/commit/aa8ae5762a7c554cfef5f167807871d5ca546a5c))
* publish releases in order and select the stable release from a signed index ([#902](https://github.com/alp82/curia/issues/902)) ([747b3e5](https://github.com/alp82/curia/commit/747b3e5d490faa8c2d0e783f89d598542ffeaaf6))
* rename Atlas to Curia app ([#843](https://github.com/alp82/curia/issues/843)) ([1d26971](https://github.com/alp82/curia/commit/1d26971fca26aa43e8caf86db401b7d0f9d9ea47))
* roll back one failed or operator-selected release ([#916](https://github.com/alp82/curia/issues/916)) ([0988a06](https://github.com/alp82/curia/commit/0988a06f72f75e4894bbd92f9949ef7aee3ee022))
* ship redacted direct diagnostics through curia doctor ([#912](https://github.com/alp82/curia/issues/912)) ([86578d2](https://github.com/alp82/curia/commit/86578d2f51ab99c94484bed994b23bc1f8585bc3))
* switch a live installation and re-adopt running sessions ([#915](https://github.com/alp82/curia/issues/915)) ([c067507](https://github.com/alp82/curia/commit/c0675072a6ec3d587db1b540fdf5ee5043d605e9))
* uninstall and reinstall while preserving installation identity ([#917](https://github.com/alp82/curia/issues/917)) ([d06fade](https://github.com/alp82/curia/commit/d06fade490f58deb281f6bdd5bd8504966841e6f))
* validate operator configuration through one atomic boundary ([#897](https://github.com/alp82/curia/issues/897)) ([9cabb5c](https://github.com/alp82/curia/commit/9cabb5c449292fee88758f684f89a2170511ef20))
* write and dry-run the one-time source cutover runbook ([#920](https://github.com/alp82/curia/issues/920)) ([948b5c0](https://github.com/alp82/curia/commit/948b5c0286aaae2c54117081546fee812f7577fc))


### Bug Fixes

* parse styled aistack device login output ([70842d1](https://github.com/alp82/curia/commit/70842d1c7c21869020ff58df5c4b0cda7068697c))
* remove terminal styling from error messages and improve session detection ([e950b73](https://github.com/alp82/curia/commit/e950b7302b983e5f9a7fd07c894e29bc01c320bb))
* stop misreporting overseer reads as refusals ([95e43b7](https://github.com/alp82/curia/commit/95e43b7c42420e5e31efd1843dcb5318e90f3664))
* write a real env file for the bundle proof in the release workflow ([#922](https://github.com/alp82/curia/issues/922)) ([27f6596](https://github.com/alp82/curia/commit/27f659699bfedc58a20aeab548b7d893f4e8f14f))

## [0.5.0](https://github.com/alp82/curia/compare/v0.4.1...v0.5.0) (2026-09-02)


### Features

* bind and verify every release artifact with one manifest ([#901](https://github.com/alp82/curia/issues/901)) ([e7b5d5d](https://github.com/alp82/curia/commit/e7b5d5dd17ab4acc118625c16d4414602bba4b7c))
* bootstrap the verified lifecycle interface with Bash ([#903](https://github.com/alp82/curia/issues/903)) ([e917948](https://github.com/alp82/curia/commit/e917948034b6f7395cf6e4662b7cbe0d4b19853e))
* build immutable service images and the versioned Compose bundle ([#900](https://github.com/alp82/curia/issues/900)) ([3e5c186](https://github.com/alp82/curia/commit/3e5c1866eed819d31110ad53054e1b1b6fc52ef6))
* build the resumable browser integration frame ([#905](https://github.com/alp82/curia/issues/905)) ([603238e](https://github.com/alp82/curia/commit/603238e06640a62a9c8b84f03cda5b2b3790dde8))
* connect and verify Anthropic during integration setup ([#910](https://github.com/alp82/curia/issues/910)) ([a6086f1](https://github.com/alp82/curia/commit/a6086f1119b99448be4a7757fd6c1579aaeb8350))
* connect and verify Discord during integration setup ([#907](https://github.com/alp82/curia/issues/907)) ([9ec45a9](https://github.com/alp82/curia/commit/9ec45a99af66b1002bf89add5a1dd490e3345ea8))
* connect and verify GitHub during integration setup ([#906](https://github.com/alp82/curia/issues/906)) ([ec9bae9](https://github.com/alp82/curia/commit/ec9bae9378d4f278d2eac4375fb70848b49de6b3))
* connect and verify OpenAI during integration setup ([#909](https://github.com/alp82/curia/issues/909)) ([df4859b](https://github.com/alp82/curia/commit/df4859b4561dc4165eaa255049138cfc7989f35c))
* connect and verify Tailscale during integration setup ([#908](https://github.com/alp82/curia/issues/908)) ([65bc1e2](https://github.com/alp82/curia/commit/65bc1e24d2ee9995b550b9e2b696d1472d0d3525))
* converge verified integrations on the Full-loop gate ([#911](https://github.com/alp82/curia/issues/911)) ([a2883c1](https://github.com/alp82/curia/commit/a2883c10c7ea6cb690a96623bfbb70ca989a4b0c))
* create and start tickets from chats ([2be7665](https://github.com/alp82/curia/commit/2be76653451ee4f5f4dd63c7b84d46735d79c293))
* discover and stage a stable Curia update ([#914](https://github.com/alp82/curia/issues/914)) ([4c8def8](https://github.com/alp82/curia/commit/4c8def873a656588ce95e8dc939eefa2ab83d7e3))
* implement supported-host preflight checks ([#899](https://github.com/alp82/curia/issues/899)) ([643935f](https://github.com/alp82/curia/commit/643935f0288e0ad32754dadd448da7f18573be22))
* install and start packaged Curia from a clean host ([#904](https://github.com/alp82/curia/issues/904)) ([8a2e428](https://github.com/alp82/curia/commit/8a2e428cb87128957e1d824a16089d05226c5084))
* integrate the canonical operator lifecycle guide ([#919](https://github.com/alp82/curia/issues/919)) ([414389c](https://github.com/alp82/curia/commit/414389cd03815ce955ce29458b04ff927564164a))
* make one real Full loop the installation acceptance ([#913](https://github.com/alp82/curia/issues/913)) ([306a96a](https://github.com/alp82/curia/commit/306a96aa0bf4212daa0ecc7bf40415fcce96fa2e))
* place secrets and mutable service data behind narrow mounts ([#898](https://github.com/alp82/curia/issues/898)) ([aa8ae57](https://github.com/alp82/curia/commit/aa8ae5762a7c554cfef5f167807871d5ca546a5c))
* publish releases in order and select the stable release from a signed index ([#902](https://github.com/alp82/curia/issues/902)) ([747b3e5](https://github.com/alp82/curia/commit/747b3e5d490faa8c2d0e783f89d598542ffeaaf6))
* roll back one failed or operator-selected release ([#916](https://github.com/alp82/curia/issues/916)) ([0988a06](https://github.com/alp82/curia/commit/0988a06f72f75e4894bbd92f9949ef7aee3ee022))
* ship redacted direct diagnostics through curia doctor ([#912](https://github.com/alp82/curia/issues/912)) ([86578d2](https://github.com/alp82/curia/commit/86578d2f51ab99c94484bed994b23bc1f8585bc3))
* switch a live installation and re-adopt running sessions ([#915](https://github.com/alp82/curia/issues/915)) ([c067507](https://github.com/alp82/curia/commit/c0675072a6ec3d587db1b540fdf5ee5043d605e9))
* uninstall and reinstall while preserving installation identity ([#917](https://github.com/alp82/curia/issues/917)) ([d06fade](https://github.com/alp82/curia/commit/d06fade490f58deb281f6bdd5bd8504966841e6f))
* validate operator configuration through one atomic boundary ([#897](https://github.com/alp82/curia/issues/897)) ([9cabb5c](https://github.com/alp82/curia/commit/9cabb5c449292fee88758f684f89a2170511ef20))
* write and dry-run the one-time source cutover runbook ([#920](https://github.com/alp82/curia/issues/920)) ([948b5c0](https://github.com/alp82/curia/commit/948b5c0286aaae2c54117081546fee812f7577fc))


### Bug Fixes

* remove terminal styling from error messages and improve session detection ([e950b73](https://github.com/alp82/curia/commit/e950b7302b983e5f9a7fd07c894e29bc01c320bb))
* stop misreporting overseer reads as refusals ([95e43b7](https://github.com/alp82/curia/commit/95e43b7c42420e5e31efd1843dcb5318e90f3664))

## [0.4.1](https://github.com/alp82/curia/compare/v0.4.0...v0.4.1) (2026-08-30)


### Bug Fixes

* parse styled aistack device login output ([70842d1](https://github.com/alp82/curia/commit/70842d1c7c21869020ff58df5c4b0cda7068697c))

## [0.4.0](https://github.com/alp82/curia/compare/v0.3.0...v0.4.0) (2026-08-30)


### Features

* rename Atlas to Curia app ([#843](https://github.com/alp82/curia/issues/843)) ([1d26971](https://github.com/alp82/curia/commit/1d26971fca26aa43e8caf86db401b7d0f9d9ea47))

## [0.3.0](https://github.com/alp82/curia/compare/v0.2.0...v0.3.0) (2026-08-29)


### Features

* automate semantic Curia releases ([77be7b3](https://github.com/alp82/curia/commit/77be7b3d0e8a9881a65b271125f085ee0b60f46f))
