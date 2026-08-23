# Provider credential failure evidence

This note answers the credential questions in [issue #643](https://github.com/alp82/curia/issues/643). It separates live measurements from provider source and open questions.

## Findings at a glance

| Question | OpenAI | Anthropic on Curia |
|---|---|---|
| Spent credential | Measured as HTTP 401 with `error.code: refresh_token_reused` | Not applicable. Curia's `setup-token` credential has no refresh token. |
| Revoked credential | Source names `refresh_token_invalidated`. The response remains unmeasured. | HTTP 401 `authentication_error` covers expired and revoked access credentials. The stable type doesn't distinguish them. |
| Plan change | A fresh login carried the new plan. Refresh behavior remains unmeasured. | No refresh occurs. Published documentation doesn't define plan-change behavior. |
| Access lifetime | Three tokens lasted exactly 10 days on one account. | `setup-token` has a documented one-year lifetime. |

The OpenAI classifier can preserve spent, expired, and revoked subtypes. All three require re-authentication, so the remediation is the same.

The Anthropic classifier can't preserve those subtypes for Curia's credential. Curia can only record that Anthropic rejected the static bearer credential.

## OpenAI refresh failures

### A spent refresh token has a provider-specific code

The August 23 recovery exchanged a refresh token after a new login had replaced its lineage. The endpoint returned this response:

```json
HTTP 401
{
  "error": {
    "message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",
    "type": "invalid_request_error",
    "param": null,
    "code": "refresh_token_reused"
  }
}
```

The full measurement is in [the credential swap live check](../live-checks/644-credential-swap-heals.md#4-what-a-spent-refresh-token-returns).

The code sits at `error.code`, inside OpenAI's error envelope. A classifier that reads only a top-level OAuth `error` misses this response.

### OpenAI source defines three terminal subtypes

Codex 0.146.0 recognizes these refresh failure codes:

- `refresh_token_expired`
- `refresh_token_reused`
- `refresh_token_invalidated`

The client maps `refresh_token_invalidated` to revoked. See the [Codex 0.146.0 refresh classifier](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/login/src/auth/manager.rs#L1378-L1404).

This source provides first-party evidence for the revoked code. It doesn't measure the revoked response's HTTP status or envelope.

The measured release also treats any HTTP 401 refresh response as permanent. See the [Codex 0.146.0 refresh request](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/login/src/auth/manager.rs#L1334-L1375).

Curia shouldn't copy that broad status rule. An unknown response doesn't prove that the credential died, and bounded retries protect against a temporary provider fault.

Current Codex also treats HTTP 400 with `invalid_grant` as permanent. See the [current Codex refresh request](https://github.com/openai/codex/blob/c9b19deb09c1841ce7acc33ddb96276030936a29/codex-rs/login/src/auth/manager.rs#L1551-L1660).

[OAuth 2.0 defines `invalid_grant`](https://www.rfc-editor.org/rfc/rfc6749.html#section-5.2) for invalid, expired, revoked, mismatched, or wrong-client refresh tokens. That standard response loses the provider subtype.

Spent and revoked tokens are distinguishable only when OpenAI returns its provider-specific code. Both remain terminal when OpenAI returns `invalid_grant` instead.

[OAuth token revocation](https://www.rfc-editor.org/rfc/rfc7009.html#section-2.2) can't measure the distinction. A conforming revocation endpoint returns HTTP 200 for both valid and invalid tokens.

## Anthropic credential failures

### Curia's credential has no refresh lineage

Curia gets its `sk-ant-oat...` value from `claude setup-token`. Anthropic documents that command as creating a static, one-year OAuth access token.

The command prints the token and doesn't save a refresh credential. See [Claude Code authentication](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token).

The `sk-ant-oat` prefix alone doesn't identify the lifecycle. Other Anthropic access credentials can use the same prefix.

The source of Curia's token identifies its lifecycle. For this path, `refresh` must remain `null`, as slice C proposes.

A spent refresh token therefore has no Anthropic equivalent in Curia. The daemon replaces a rejected token through `claude setup-token`.

### The stable API type groups expired and revoked credentials

Anthropic documents HTTP 401 `authentication_error` for malformed, expired, or revoked credentials. The error body always contains `error.type` and `error.message`.

See the [Claude API error contract](https://platform.claude.com/docs/en/api/errors#http-errors). The contract doesn't define separate expired and revoked types.

Curia should key on HTTP status and `error.type`. Curia shouldn't key on the message because Anthropic doesn't make message text part of the stable contract.

An interactive `/login` credential is a different path. It stores a refresh token and uses a refresh grant.

Anthropic's official TypeScript Software Development Kit (SDK) reads `expires_at`, posts the refresh grant, and accepts the server's `expires_in`. See the [user OAuth provider](https://github.com/anthropics/anthropic-sdk-typescript/blob/bfa9197f0182084941052be9752c948638421601/src/lib/credentials/user-oauth.ts#L28-L143).

Claude Code 2.1.220 classifies HTTP 400 or 401 `invalid_grant` as a dead interactive refresh token. It doesn't define separate spent and revoked codes.

That behavior comes from the [official Claude Code 2.1.220 artifact](https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/-/claude-code-linux-x64-2.1.220.tgz). It doesn't change Curia's static token path.

## Plan changes

### OpenAI invalidated one access token early, but causation remains open

During the incident, OpenAI returned `token_expired` while the access token's `exp` remained about 12 hours away. The token still claimed `chatgpt_plan_type: plus`.

The operator had upgraded from Plus to Pro. The timing correlates with the upgrade, but the evidence doesn't prove that the upgrade caused the rejection.

The old refresh token remained usable after the upgrade. Its later `refresh_token_reused` response proves that an exchange had succeeded and rotated the lineage.

The failed local write lost that successful refresh response. The evidence therefore doesn't show whether the response carried the new plan claim.

A later login carried `chatgpt_plan_type: prolite`. See [the measured comparison](../live-checks/644-credential-swap-heals.md#2-what-a-fresh-credential-carries).

Codex persists a returned `id_token`, and Codex reads the plan from that token. The refresh response makes `id_token` optional.

See [Codex token persistence](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/login/src/auth/manager.rs#L1308-L1331). No source promises that a refresh returns updated plan claims.

Treat resource-server `token_expired` as a refresh trigger, even before local `exp`. Don't treat the response as proof that the refresh grant died.

If the refresh succeeds, retry the original request once. If the refresh returns a known terminal code, start re-authentication.

### Anthropic plan-change behavior remains unknown

Curia's static token carries no readable JWT plan claim. Anthropic says the token authenticates with the user's subscription and requires a supported paid plan.

Anthropic doesn't state whether a plan change invalidates that token. Anthropic also doesn't state when server-side entitlements change for an existing token.

There is no refresh operation that could pick up a plan change. On a plan-related rejection, create a new `setup-token` through the existing operator flow.

## Token lifetimes

### OpenAI measured ten days three times

Three access tokens from one account had exact ten-day lifetimes. Two measurements appear in [the credential swap check](../live-checks/644-credential-swap-heals.md#2-what-a-fresh-credential-carries).

The third appears in [the re-authentication check](../live-checks/642-codex-reauth.md#the-adopted-credential). The samples cover August 13 and two logins on August 23, 2026.

OpenAI doesn't publish ten days as a provider contract. The measurement supports the current 25 percent margin, but not a hard-coded ten-day lifetime.

Keep reading each token's own `iat` and `exp`. Keep the fixed minimum margin, and journal the computed lifetime whenever it changes.

This rule refreshes 2.5 days early for the measured tokens. A future lifetime change remains visible and doesn't require a code change.

### Anthropic documents one year for Curia's token

Anthropic documents one year for `claude setup-token`. This lifetime is separate from interactive `/login` access tokens.

The static token doesn't expose a parseable expiry claim. Record the issue time when Curia adopts a new token, then calculate its one-year expiry.

For an existing token with no known issue time, report the expiry as unknown. Re-authenticate once to establish a trustworthy clock.

Anthropic doesn't publish a fixed interactive access-token lifetime. Its official SDK uses each response's `expires_in` rather than a constant.

## Classifier recommendation

Use one classifier per operation. A resource-server rejection and a refresh rejection don't carry the same meaning.

### OpenAI refresh classifier

Read a normalized code from these locations, in order:

1. Read `payload.error.code`.
2. Read a string `payload.error`.
3. Read `payload.code`.

Then classify the result:

- Return `{ transient: false }` for HTTP 400 or 401 with `refresh_token_expired`, `refresh_token_reused`, or `refresh_token_invalidated`.
- Return `{ transient: false }` for HTTP 400 with `invalid_grant`.
- Return `{ transient: true }` for transport errors, timeouts, HTTP 408, HTTP 429, and HTTP 5xx.
- Return `{ transient: true }` for every unrecognized response, including an unknown HTTP 401.
- Return `{ transient: true }` when a success response has no usable access token.

The retry owner bounds all transient results. After the bound, escalate the repeated unknown response without relabeling the credential as revoked.

### Anthropic static-token classifier

Curia has no Anthropic refresh classifier because Curia has no Anthropic refresh operation.

For a model request, classify these results:

- Return `{ transient: false }` for HTTP 401 with `error.type: authentication_error`.
- Return `{ transient: false }` for HTTP 403 with `error.type: permission_error`.
- Return `{ transient: true }` for connection errors, HTTP 408, HTTP 429 with `retry-after`, and HTTP 5xx.
- Return `{ transient: true }` for every unrecognized response until the bounded retry count ends.

Anthropic documents connection errors, rate limits, and 5xx responses as transient. See the [Claude API retry guidance](https://platform.claude.com/docs/en/api/errors#http-errors).

A terminal 401 means the static credential needs replacement. A terminal 403 needs a human, but it doesn't prove expiry or revocation.

### Journal fields and `why`

Journal the provider, operation, HTTP status, normalized code, error type, request ID, and retry count. Never journal the response body or token fragments.

Use factual `why` values:

```js
{ transient: false, why: 'OpenAI refresh returned HTTP 401 refresh_token_reused, so the refresh token was already exchanged' }
{ transient: false, why: 'OpenAI refresh returned HTTP 401 refresh_token_invalidated, which OpenAI defines as revoked' }
{ transient: true, why: 'OpenAI refresh returned an unrecognized HTTP 401, so retry 1 of 3 preserves the last good credential' }
{ transient: false, why: 'Anthropic rejected the static bearer with HTTP 401 authentication_error, which groups expired and revoked credentials' }
{ transient: true, why: 'Anthropic request timed out before a response arrived' }
```

Don't use `token_expired` from a model request as a terminal refresh result. Use that result to start one refresh attempt first.

## Evidence gaps

- OpenAI's revoked response still needs a controlled live measurement.
- OpenAI's refresh-after-plan-change behavior still needs a controlled measurement.
- OpenAI's ten-day lifetime has no provider-wide guarantee.
- Anthropic's exact revoked static-token message remains unmeasured and isn't a stable classifier key.
- Anthropic's plan-change behavior remains undocumented and unmeasured.
- Anthropic's normal interactive access-token lifetime remains undocumented and unmeasured.
