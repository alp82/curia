# The cost of deferred Curia tools in the Codex pane lane

Evidence for [What the deferred tool offer costs a codex agent in a pane](https://github.com/alp82/curia/issues/579).

This note covers Codex CLI 0.146.0 and the Curia tool set on 2026-08-22.
The matching source is the [`rust-v0.146.0` release](https://github.com/openai/codex/releases/tag/rust-v0.146.0).
Its commit is `e363b08c9175ac1cbe5893615dd2cb9ddf95043b`.

## Measured answer

The deferred catalog caused no obedience failure in 20 real-model runs.
All 20 runs called the requested tool once with the exact required fields.

The token cost depended on the tool schema.
A simple `notify` call needed no separate discovery request in any run.
The pane lane used two model requests and a median 24,993 total tokens.

A complex `report_result` call usually needed schema discovery first.
The pane lane used two to five model requests, with a median of four.
A direct call and its final answer need two model requests.
Thus, the pane lane added a median two model requests for the complex call.

The complex pane run used a median 51,937 total tokens.
Its `codex exec` control used a median 38,159 total tokens and three model requests.
The pane difference was 13,778 total tokens and 6.05 seconds to the first tool call.

Both current lanes used the same deferred `ALL_TOOLS` catalog.
The pane lane did not use the native `tool_search` sequence from the earlier probe.
The current route changed the carriage, but it did not remove deferred discovery.

The cost is in tokens, not measured obedience.
The evidence does not prove a zero failure rate beyond these prompts and runs.

## Native tool-search mechanism

Native `tool_search` needs one extra model response before the first Curia call.
The model must call `tool_search` before it can call a discovered Curia tool.

This requirement creates two possible costs.

1. The model spends tokens and time on the search response.
2. The task fails if the model omits the search or selects the wrong result.

Tool search can reduce later input tokens because Codex does not send every Curia schema up front.
The saving can exceed the search cost for a large tool set.
The OpenAI documentation does not claim this result for a small tool set.

The mechanism alone cannot give the net token cost or the failure rate.
A real-model comparison must measure both values.

## What Codex 0.146.0 does

Codex marks every MCP tool as deferred when the selected model supports tool search.
The exposure code uses only two states for this choice.
It selects `Deferred` when tool search is available and `Direct` otherwise.
See [`mcp_tool_exposure.rs:19-55`](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/core/src/mcp_tool_exposure.rs#L19-L55).

The model and provider decide whether tool search is available.
The model must support search, and the provider must support namespaces.
See [`spec_plan.rs:333-346`](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/core/src/tools/spec_plan.rs#L333-L346).

The two old feature keys cannot change this behavior.
The source calls `tool_search` a removed no-op because search is always enabled.
It calls `tool_search_always_defer_mcp_tools` a removed flag because MCP tools always defer.
See [`features/src/lib.rs:169-174`](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/features/src/lib.rs#L169-L174).

The feature table keeps both keys only for compatibility.
It marks both as `Removed` and gives the deferral key a true default.
See [`features/src/lib.rs:1122-1142`](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/features/src/lib.rs#L1122-L1142).

The tagged tests also cover a small MCP tool set.
They require `tool_search` and forbid an MCP tool in the first request.
See [`search_tool.rs:182-219`](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/core/tests/suite/search_tool.rs#L182-L219).

The earlier local pane probe found this result with its stand-in provider.
The pane offered `tool_search`, while `codex exec` exposed Curia tools directly.
See [the pane probe result](pane-keystroke-codex.md#what-else-the-probe-saw).

That probe [bypasses search](pane-keystroke-codex.probe.mjs#L253) with a scripted direct Curia call.
It also [hard-codes](pane-keystroke-codex.probe.mjs#L237) one input token and one output token.
Thus, the probe measures neither token cost nor model obedience.

## What the model receives

Codex sends one client-executed `tool_search` definition in the first model request.
Its required `query` field asks for a search query over deferred tools.
Its optional `limit` field defaults to eight results.
See [`tool_search_spec.rs:13-76`](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/core/src/tools/handlers/tool_search_spec.rs#L13-L76).

The description tells the model to use `tool_search` for MCP tool discovery.
It also lists the available source names when world state does not list them.
This text gives guidance, not an automatic search operation.

Codex builds the search index from each MCP tool name and server name.
It also adds the tool description, namespace description, and parameter names.
See [`mcp.rs:267-313`](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/core/src/tools/handlers/mcp.rs#L267-L313).

The client runs a BM25 search with the model's query.
It returns the matching tool definitions in a `tool_search_output` item.
See [`tool_search.rs:147-196`](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/core/src/tools/handlers/tool_search.rs#L147-L196).

The default search limit is eight tools.
The ranking code gives no separate priority to an exact tool name.
See [`tool_discovery.rs:5-8`](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/tools/src/tool_discovery.rs#L5-L8).

Codex then sends a second model request with the search output in the conversation history.
It does not add the discovered tool to the request's normal tool list.
The tagged test preserves this history after the MCP call too.
See [`search_tool.rs:531-813`](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/core/tests/suite/search_tool.rs#L531-L813).

The full successful sequence has three model requests.

1. The model requests `tool_search`.
2. The model requests the discovered MCP tool.
3. The model answers after the MCP result.

A direct offer needs only the last two requests for the same one-tool task.
Thus, deferred discovery adds one model request before the first Curia call.

## Token economics

OpenAI says tool search avoids all full tool definitions in the initial context.
OpenAI says this design may reduce overall token use and cost.
The service appends discovered tools to preserve the prompt cache.
See the [official tool search guide](https://developers.openai.com/api/docs/guides/tools-tool-search).

OpenAI also states that function definitions count as billed input tokens.
See the [official function token guide](https://developers.openai.com/api/docs/guides/function-calling#token-usage).

The guide recommends namespaces or MCP servers for the largest token savings.
It also recommends fewer than ten functions per namespace.
These statements describe large tool surfaces, not a guaranteed saving for every tool set.

Curia exposes seven ticket tools from one MCP server in this session.
Their registrations start at `daemon/src/index.mjs:1480-1782`.
The deferred offer replaces these schemas with one search definition and the Curia source name.

The first correct Curia call then adds three token items.

1. The first response contains the model's search call and possible reasoning tokens.
2. The next request contains the `tool_search_call` and the returned Curia schema.
3. Later requests retain that search output in the conversation history.

The direct lane pays for all seven Curia schemas in every initial request.
Prompt caching can reduce the billed cost of repeated identical input.
The token counters still report cached input separately from uncached input.

No source can determine which side is smaller for Curia.
The result depends on schema size, model output, cache use, and the number of later model requests.

Codex records input, cached input, cache-write, output, and reasoning tokens for each response.
See [`responses.rs:114-157`](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/codex-api/src/sse/responses.rs#L114-L157).

Codex also stores the last response usage and the accumulated usage.
See [`protocol.rs:2055-2111`](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/protocol/src/protocol.rs#L2055-L2111).

Thus, the experiment must sum all responses.
It must keep cached input separate from uncached input.

## Obedience risk

The tool description says the model should search.
The handler only runs after the model produces a `tool_search_call`.
The tagged tests script this call and do not test model judgment.

Codex sends `tool_choice: "auto"` with each Responses request.
See [`client.rs:907-913`](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/core/src/client.rs#L907-L913).

OpenAI defines `auto` as permission for zero, one, or multiple tool calls.
See the [official tool-choice guide](https://developers.openai.com/api/docs/guides/function-calling#tool-choice).

Codex therefore does not force the model to search.
The model can answer or stop without a tool call.

The model must make three correct decisions before the first Curia call.

1. Recognize that the requested action needs a deferred tool.
2. Write a query that retrieves the correct Curia tool.
3. Call the returned tool with a valid payload.

A direct offer removes the first two decisions.
It gives the model the target tool name, description, and schema in the first request.

This difference matters most for mandatory ending tools.
The standing orders require `report_result` exactly once at the end.
An omitted search can leave a completed task unable to report its result.

## Live experiment

The rig is in [`prototypes/deferred-tool-offer`](../../prototypes/deferred-tool-offer).
It used Codex CLI 0.146.0, `gpt-5.6-sol`, high effort, and the active account.

The rig used a harmless stdio MCP stand-in named `curia`.
It exposed `notify` and `report_result` with their relevant schemas.
The MCP log, not the model report, decided whether each run obeyed the prompt.

The rig ran five pane samples and five `codex exec` samples for each prompt.
Each run used a new worktree and a new `CODEX_HOME` with a credential copy.
The pane samples ran before the exec samples.

The `notify` prompt named the tool and required one exact message.
The `report_result` prompt described the tool without naming it.
It required an exact status, ticket, headline, and summary.

| Prompt | Lane | Exact calls | Model requests | Median total tokens | Median uncached input | Median output | Median reasoning | Median first-call time |
| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| `notify` | pane | 5/5 | 2, 2, 2, 2, 2 | 24,993 | 1,750 | 281 | 167 | 6.96 s |
| `notify` | exec | 5/5 | 2, 2, 2, 2, 2 | 24,641 | 2,344 | 281 | 177 | 6.77 s |
| `report_result` | pane | 5/5 | 4, 5, 4, 2, 4 | 51,937 | 5,441 | 701 | 320 | 18.78 s |
| `report_result` | exec | 5/5 | 3, 3, 4, 3, 3 | 38,159 | 4,433 | 527 | 251 | 12.73 s |

The two matrix files contain each sample and each token field.
See [`sol-matrix.json`](../../prototypes/deferred-tool-offer/out/sol-matrix.json) and [`report-matrix.json`](../../prototypes/deferred-tool-offer/out/report-matrix.json).

## What the runs show

The current model did not receive native `tool_search` in either lane.
It received one `exec` tool and a deferred `ALL_TOOLS` catalog inside that tool.

For `notify`, the model filtered the catalog and called the tool in one script.
Deferred discovery added no model request in these ten runs.

For `report_result`, the model sometimes guessed the schema in the first script.
It usually printed catalog matches before it formed the call.
Each printed result caused another model request.

The pane used one to three catalog scripts before its tool call.
Its median run added two model requests above the direct two-request sequence.

The exec control also used the deferred catalog.
It added a median one model request above the direct sequence.
Thus, this control measures lane behavior, not a direct-offer counterfactual.

All 20 calls succeeded, so these runs found no obedience cost.
They do not cover implicit status updates, multiple Curia tools, or long sessions.
The stand-in exposed two tools, while this Curia session exposed seven.
Five samples per prompt do not give a precise low failure rate.

## Conclusion

Deferred discovery has no fixed token cost on the current Codex route.
A simple tool can cost no request, while a complex tool can cost multiple requests.

For `report_result`, the pane median was two extra requests and 13,778 tokens above the exec control.
Most input tokens came from the prompt cache, but the context meter still counts them.

The follow-up ticket must treat this as a token cost.
The measurement does not justify an obedience repair from these 20 runs alone.
