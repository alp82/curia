# Credential ownership and recovery for OpenCode and Pi

Date: August 29, 2026.

Research question: For each candidate that can satisfy Curia's selectable-harness contract, where do model credentials live, how does Curia deliver them, and how does a dead credential heal?

This note resolves the research requested by [Design credential ownership and recovery for candidate harnesses](https://github.com/alp82/curia/issues/828). It uses the conditional-pass findings from [Measure OpenCode and Pi against the selectable-harness contract](https://github.com/alp82/curia/issues/827) and the contract settled in [ADR-0029](https://github.com/alp82/curia/blob/main/docs/adr/0029-selectable-harnesses-satisfy-one-behavioral-contract.md). The credential boundary comes from [ADR-0027](../adr/0027-the-daemon-owns-model-credentials.md).

## Result

Both viable candidates can use Curia's existing **OpenAI subscription provider**. Neither candidate needs a new provider store, refresh lineage, or reauthentication flow.

Curia should project one access-token lease from its daemon-owned Codex store into each candidate's native `auth.json`. The projection must carry an empty refresh token. Both native schemas require a string, but neither client reads that string before the access token expires. An empty value keeps the host refresh token out of the agent container and prevents a candidate from rotating Curia's lineage.

The two candidates need separate consumer rows because their provider keys, paths, and read mechanisms differ:

| Consumer | Provider | Delivered path under the mounted config root | Native provider key | Healing |
| --- | --- | --- | --- | --- |
| OpenCode 1.18.23 | `openai` | `data/opencode/auth.json` when `XDG_DATA_HOME=/cfg/data` | `openai` | Atomic rewrite, then the next model request. No process restart. |
| Pi 0.84.3 | `openai` | `auth.json` when `PI_CODING_AGENT_DIR=/cfg` | `openai-codex` | Atomic rewrite, then the next model request. No process restart. |

This design preserves the provider-keyed store. `reauth openai` remains the only operator login. A successful login heals Codex, OpenCode, and Pi from one adopted host credential.

The exact-image probes prove that each running process opens the replacement file for a later request. They used invalid tokens, so they don't prove successful provider-backed recovery. ADR-0029's real-credential live replacement check remains a selection gate.

## Keep one OpenAI provider contract

The provider row remains `openai`:

| Provider responsibility | Decision |
| --- | --- |
| Source store | Keep the daemon-owned Codex `auth.json`. Don't create OpenCode-owned or Pi-owned host stores. |
| Expiry | Read `iat` and `exp` from `tokens.access_token`, as ADR-0027 does now. |
| Scheduled refresh | Keep the dispatch-tick broker and its last-quarter refresh margin. Write the host store first, then fan out native projections. |
| Early rejection | A normalized OpenAI model refusal such as `token_expired` triggers one immediate broker refresh. It is not proof that the refresh token is dead. |
| Refresh failure | Keep the current terminal-code classifier and bounded transient retries. A known dead refresh token holds the `openai` provider. |
| Reauthentication | Keep `codex login --device-auth` in the existing provider-keyed `curia-auth-openai` session. Adopt only the resulting host store. |

OpenCode and Pi use the same public OpenAI OAuth client ID as Codex, `app_EMoamEEZ73f0CkXaXp7hrann`. OpenCode's pinned plugin declares that client, refresh endpoint, and ChatGPT backend in its [OpenAI OAuth implementation](https://github.com/anomalyco/opencode/blob/v1.18.23/packages/opencode/src/plugin/openai/codex.ts). Pi declares the same client and supports both browser and headless device login in its [OpenAI OAuth implementation](https://github.com/earendil-works/pi/blob/v0.84.3/packages/ai/src/auth/oauth/openai-codex.ts).

Curia should not run either candidate's login command. A consumer login would make that consumer the writer of a second refresh lineage. It would also make recovery depend on which harness happened to authenticate. The provider-keyed flow already journals start and terminal events, survives daemon restarts, and gives the operator one dashboard and terminal surface.

An early resource-server rejection needs one small provider-contract extension. The existing [provider-failure research](provider-credential-failures.md) found that `token_expired` can arrive before the JWT's local `exp`. Candidate transcript adapters should normalize a stable auth-refusal code and notify the OpenAI broker. The broker then refreshes, fans out, and nudges the stopped turn. An arbitrary HTTP 401 remains nonterminal until the refresh classifier answers, because a model refusal doesn't prove that the refresh grant is dead.

### Don't open an alternative provider lane

This choice is independent for each candidate. OpenCode can use ChatGPT Plus or Pro through its built-in OpenAI OAuth plugin, as its [provider guide](https://github.com/anomalyco/opencode/blob/v1.18.23/packages/web/src/content/docs/providers.mdx) documents. Pi exposes the distinct `openai-codex` subscription provider described in its [provider guide](https://github.com/earendil-works/pi/blob/v0.84.3/packages/coding-agent/docs/providers.md). Both paths fit the existing OpenAI provider contract.

API-key variants stay out because ADR-0027 requires subscription credentials. GitHub Copilot OAuth would need a third provider store, refresh classifier, reauthentication lane, and usage detector. Pi's Anthropic login would create a rotating, full-account lineage that ADR-0027 already refused for agent containers. Those alternatives add credential authority without answering a contract gap in either candidate.

## Deliver an access-only native projection

The daemon should parse its host record once and reject delivery unless it finds a usable access token, an expiry, and an account ID. It should never copy `id_token`, the real `refresh_token`, `OPENAI_API_KEY`, or unrelated Codex state into a candidate store.

The OpenCode projection is:

```jsonc
{
  "openai": {
    "type": "oauth",
    "access": "<tokens.access_token>",
    "refresh": "",
    "expires": ACCESS_TOKEN_EXP_MS,
    "accountId": "<tokens.account_id>"
  }
}
```

`expires` is the access token's JWT `exp` in milliseconds, not the host file's `last_refresh` and not a guessed lifetime. OpenCode's native OAuth schema requires `access`, `refresh`, and `expires`; `accountId` is optional. Its auth service reads the file under the data root on every `get`, while `OPENCODE_AUTH_CONTENT` would freeze a value in the process environment. See the pinned [auth store](https://github.com/anomalyco/opencode/blob/v1.18.23/packages/opencode/src/auth/index.ts) and [global data-root definition](https://github.com/anomalyco/opencode/blob/v1.18.23/packages/core/src/global.ts).

The Pi projection is:

```jsonc
{
  "openai-codex": {
    "type": "oauth",
    "access": "<tokens.access_token>",
    "refresh": "",
    "expires": ACCESS_TOKEN_EXP_MS,
    "accountId": "<tokens.account_id>"
  }
}
```

Pi keys stored credentials by provider ID, and its subscription provider ID is `openai-codex`. See the pinned [provider definition](https://github.com/earendil-works/pi/blob/v0.84.3/packages/ai/src/providers/openai-codex.ts) and [OAuth credential types](https://github.com/earendil-works/pi/blob/v0.84.3/packages/ai/src/auth/types.ts). Pi derives request authentication from `credential.access`; the stored account ID matches Pi's native login shape, while the request layer also validates the account claim in the access token. See Pi's [OAuth conversion](https://github.com/earendil-works/pi/blob/v0.84.3/packages/ai/src/auth/oauth/openai-codex.ts) and [Codex request headers](https://github.com/earendil-works/pi/blob/v0.84.3/packages/ai/src/api/openai-codex-responses.ts).

Write both files with a temporary sibling plus `rename`, then restore mode `0400`. The empty refresh token is the authority boundary. Mode `0400` remains a second belt against each client's in-place writer.

This is stricter than copying the host record. OpenCode refreshes only after its recorded expiry, then writes through its auth service. Its writer uses an in-place `writeFileString` followed by `chmod`; see the pinned [filesystem service](https://github.com/anomalyco/opencode/blob/v1.18.23/packages/core/src/fs-util.ts). Pi refreshes inside the last five minutes and persists through a serialized in-place write; see its [OAuth resolver](https://github.com/earendil-works/pi/blob/v0.84.3/packages/ai/src/auth/resolve.ts) and [file backend](https://github.com/earendil-works/pi/blob/v0.84.3/packages/coding-agent/src/core/auth-storage.ts). With `refresh: ""`, neither candidate can spend the daemon's real refresh token even if the daemon stays down past the access expiry.

## Running processes adopt an atomic replacement

### OpenCode reads for each provider request

OpenCode's provider fetch wrapper calls `getAuth()` immediately before it sets the bearer and account headers. `getAuth()` reaches the auth service, whose `all()` reads `auth.json` each time. See the pinned [request wrapper](https://github.com/anomalyco/opencode/blob/v1.18.23/packages/opencode/src/plugin/openai/codex.ts) and [auth service](https://github.com/anomalyco/opencode/blob/v1.18.23/packages/opencode/src/auth/index.ts).

The exact pinned-image probe kept one `opencode serve` process and one session alive. It sent a model request, atomically replaced `auth.json`, then sent a second request. `inotifywait` recorded `MOVED_TO auth.json` at the replacement and fresh `OPEN auth.json` events during the second request. Both invalid access tokens reached the ChatGPT backend and received HTTP 401. The process didn't restart.

### Pi revision-checks for each credential operation

Pi's `AuthStorage.read()` compares a revision made from device, inode, size, modification time, and change time. If the revision changed, Pi locks and reloads the file before returning the credential. The model runtime calls this path while preparing each request. See the pinned [revision helper](https://github.com/earendil-works/pi/blob/v0.84.3/packages/coding-agent/src/utils/paths.ts), [auth storage](https://github.com/earendil-works/pi/blob/v0.84.3/packages/coding-agent/src/core/auth-storage.ts), and [model runtime](https://github.com/earendil-works/pi/blob/v0.84.3/packages/coding-agent/src/core/model-runtime.ts).

The exact pinned-image probe kept one Pi RPC process alive. It sent one prompt, waited for `agent_settled`, atomically replaced `auth.json`, then sent a second prompt. `inotifywait` recorded the replacement and a new `OPEN auth.json` for the second prompt. Both invalid tokens reached the ChatGPT backend and received HTTP 401. The process didn't restart.

These probes establish the file-read and no-restart behavior needed by the design. Before either candidate becomes selectable, repeat the same sequence with a disposable valid subscription credential and prove that the second request succeeds after the first credential is rejected.

## Hold and recovery behavior

OpenCode and Pi should join the existing provider-wide recovery sequence:

1. The broker refreshes before expiry and atomically rewrites every live consumer projection on each dispatch tick.
2. If a model request reports a recognized early-expiry refusal, the adapter asks the same broker for an immediate refresh.
3. If refresh succeeds, the broker writes the host store first, fans out every native projection, and records each healed consumer.
4. If refresh proves the grant dead, Curia holds `openai`, freezes every Codex, OpenCode, and Pi agent, and starts one provider login.
5. While held, Curia refuses new OpenAI dispatches and skips the stall ladder for affected agents. It preserves each pane, claim, worktree, and conversation.
6. After reauthentication, Curia adopts the host record, fans it out on the same tick, lifts the hold, and lets the next harness-specific safe nudge retry the stopped turn.

This sequence stays truthful across a daemon restart. The provider store still states its token clock. The next tick re-derives refresh need and re-fans every adopted live agent. The existing reauthentication journal restores a login that outlives the daemon. Consumer status comes from the shared provider state plus each declared delivery, so three rows don't invent three independent OpenAI credentials.

The Credentials screen and status output should list separate Codex, OpenCode, and Pi consumers under one OpenAI provider. `reauth openai` remains one action. A hold alarm should name all affected consumers and all frozen sessions. It must not present a reset time because reauthentication, not a clock, ends the hold.

## Required migrations

No credential data migration is required. The host Codex store remains authoritative.

Implementation needs these bounded changes before a candidate can be selected:

1. Add an OpenCode and/or Pi consumer row only when that harness becomes selectable. Both rows name `provider: "openai"` and `heal: "in-place"`.
2. Let a `config-dir` delivery name a safe relative path. OpenCode needs `data/opencode/auth.json`; Pi needs `auth.json`.
3. Add one host-to-native projection function. Validate the access JWT and account ID, emit an empty refresh string, and write atomically at mode `0400`.
4. Generalize the OpenAI broker's Codex-only fan-out and status text across every live OpenAI consumer. Journal the actual consumer on each rewrite.
5. Refuse spawn when the provider store is absent, unreadable, expired, or can't produce the candidate's native shape.
6. Teach candidate transcript adapters to normalize credential refusal evidence and request an immediate provider refresh. Don't classify a generic 401 as a dead refresh token.
7. Extend credential cleanup to remove OpenCode's nested delivery file as well as top-level `auth.json`. Never walk or delete the host store.
8. Add fixtures for projection, permissions, atomic replacement, no-op fan-out, malformed host records, restart reconcile, provider holds, reauthentication adoption, and consumer-specific cleanup.
9. Pass ADR-0029's focused valid-credential replacement check in the pinned worker image before routing exposes the harness.

Existing OpenCode or Pi experiment directories don't need conversion. They weren't selectable and aren't evidence of a daemon-owned credential. On first managed spawn, Curia should overwrite the declared native path from the provider store and refuse any other credential source, including environment variables.

## Amend ADR-0027 without superseding it

The evidence strengthens ADR-0027 rather than replacing it. Amend the ADR in the implementation ticket as follows:

- Replace the fixed phrase “three consumers” with a named current-consumer list. Add each candidate only when routing makes it selectable.
- State that one provider record can project into multiple native consumer formats and paths.
- State that a lease doesn't include refresh authority when the native schema accepts an inert placeholder. OpenCode and Pi receive `refresh: ""`.
- Add consumer-reported model refusals as an early trigger for the provider refresh operation. Keep refresh-result classification provider-owned.
- Record both candidate rows as in-place healing with no process restart, subject to the required valid-credential live check.

Keep all other OpenAI decisions: one daemon-owned provider store, one refresh lineage, host-first writes, atomic fan-out, provider-keyed reauthentication, provider holds, restart reconciliation, and no API-key fallback.

## Evidence log

The source review used exact release tags:

```text
OpenCode v1.18.23  ef2880f379129aa048be9e9353e30aa168d42c17
Pi v0.84.3        4e58f324fae8ebfa98a3d45181fb248072a2afac
```

The live probes used worker image `curia-agent:2.1.220-0.146.0-2cd55c92` (`sha256:bdd4d9b592b9265b7c479e8189503e66752dbe8dda297035edee339a6a8547e2`). Each probe ran as uid 1000 with the candidate's documented relocated roots.

The OpenCode probe used its HTTP server so two model requests shared one process and session. The relevant observation was:

```text
OPEN auth.json
MOVED_TO auth.json
OPEN auth.json
```

The Pi probe used RPC mode so two prompts shared one process. The relevant observation was:

```text
OPEN auth.json
MOVED_TO auth.json
OPEN auth.json
```

Each request produced an accepted harness turn followed by a provider authentication error and a settled process. No disposable valid subscription credential was available. The probe therefore claims file adoption and process continuity, not successful generation after replacement.

A focused follow-up replaced each record's refresh value with `""` and kept the fake access token future-dated. OpenCode reached the resource server without entering refresh. Pi accepted the prompt and entered the model turn without a refresh or store-write error; its provider request exceeded the 15-second probe bound. This proves that both pinned binaries accept the access-only projection before expiry. It doesn't replace the valid-credential or near-expiry selection checks.
