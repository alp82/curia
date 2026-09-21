# UI foundations for the Curia app redesign

Research date: September 21, 2026. Local baseline: `acfa89d`.

Question: [Which standard UI foundations fit Curia’s redesign constraints?](https://github.com/alp82/curia/issues/1019)

## Finding

Standard React components are viable, but adopting them changes Curia's frontend architecture. They don't require replacing the Curia service. Two conversation approaches deserve evaluation: owned presentation components using AI Elements, or assistant-ui with an external-store adapter. React Flow is a candidate if the chosen map experience needs a navigable dependency graph. None of these choices settles navigation, visual hierarchy, or the role of conversation.

This is research, not a stack selection. Implementation cost assessments and prototype criteria below are inferences from the documented interfaces and the local code.

## Current constraints

The [app source](../../daemon/assets/dashboard.html) contains styles, route handling, rendering, and browser state in one HTML file. [The package manifest](../../daemon/package.json) has no React dependency or frontend build command. [App tests](../../daemon/test/dashboardpage.test.mjs) extract the inline script and run it in a Node VM. A React migration therefore needs build output, browser-oriented component tests, and a deliberate replacement for implementation-specific VM tests.

[The app server](../../daemon/src/dashboard.mjs) serves the HTML directly, checks page/protocol compatibility, and proxies service operations. It has no general frontend asset route. Bundled JavaScript and CSS need authenticated serving, packaging, cache behavior, and compatibility checks. An inline bundle is another packaging option, but would still be generated output.

The app reads overview snapshots and consumes a custom EventSource timeline. Timeline events include `hello`, `items`, `reset`, `dialog`, `escalations`, `esc_history`, `draft`, and `sent`. Writes use `/send`, `/draft`, `/key`, `/take-back`, and `/dialog-answer`. This isn't evidence of AI SDK wire-protocol compatibility. Conversation state also distinguishes ended sessions, reconnecting streams, drafts, receipts, and harness interactions. [App chat implementation](../../daemon/assets/dashboard.html), [server routes](../../daemon/src/dashboard.mjs).

Existing decisions constrain migration: identity gates reads and writes, typed decision cards share answer markers and receipts across surfaces, and a composite send can contain multiple messages. A generic chat component must retain these semantics or explicitly reopen the decisions. [Identity boundary](../adr/0011-tailscale-identity-in-front-of-every-attach-surface.md), [card parity](../adr/0025-the-cards-under-the-one-voice.md), [composite sends](../adr/0026-the-composite-send.md).

## Candidate comparison

The candidates serve different layers and can be combined selectively.

| Foundation | Documented contribution | Curia integration cost and limitation |
| --- | --- | --- |
| shadcn/ui | Editable component source; a React/Vite installation path; theme tokens through CSS variables. | Establish React, Tailwind, and a build first. Curia owns changes to copied components and must maintain their accessibility. No model or service protocol is imposed. |
| AI Elements | Composable chat and workflow presentation, copied into the project, with shadcn conventions and AI SDK integration. | Presentation can be adapted to Curia state, but SDK-shaped props need translation. Don't copy a model execution example into the browser/service architecture without a separate decision. |
| assistant-ui | React conversation primitives, streaming UI, scrolling, attachments, keyboard support, and custom runtimes. | ExternalStoreRuntime can consume existing state. Curia must map its timeline and wire only actions the service supports. Its conversation runtime adds a state abstraction to maintain. |
| React Flow | React nodes, edges, viewport controls, and customizable graph rendering. | Map domain data must become nodes, edges, and positions. This doesn't supply Curia's plan semantics or persist roadmap edits. A graph may be unnecessary if an outline communicates the plan better. |

Sources: [shadcn introduction](https://ui.shadcn.com/docs), [Vite installation](https://ui.shadcn.com/docs/installation/vite), [AI Elements overview](https://ai-sdk.dev/elements/overview), [assistant-ui repository](https://github.com/assistant-ui/assistant-ui), and [React Flow repository](https://github.com/xyflow/xyflow).

### shadcn/ui

CSS-variable tokens cover semantic colors and support theme overrides. This supplies a common vocabulary for the redesign instead of per-screen colors. The documented Vite path establishes that adopting shadcn doesn't itself require Next.js. [Theming](https://ui.shadcn.com/docs/theming), [Vite installation](https://ui.shadcn.com/docs/installation/vite).

Inference: use shared primitives for dialogs, forms, navigation, and actions, then test their composition. Library accessibility claims don't establish that Curia's focus order, labels, contrast, or mobile layout are correct. Responsive navigation and touch targets remain product work.

### AI Elements

The introduction targets React 19 and Tailwind CSS 4. Its documented starting environment includes Next.js, AI SDK, and shadcn. Installation copies selected component source and dependencies into the project. The overview demonstrates composed presentation and simulated streaming, but this research didn't compile the components against Curia or verify a Vite integration. [AI Elements introduction](https://elements.ai-sdk.dev/docs), [overview and examples](https://ai-sdk.dev/elements/overview).

Inference: selectively adopting message, conversation, and prompt components keeps Curia's transport explicit. That also leaves Curia responsible for reconnects, state reconciliation, and custom decision cards. Evaluate actual component imports before claiming the entire collection is backend-independent. The docs' recommended AI Gateway is not a reason to introduce another model execution path.

### assistant-ui

ExternalStoreRuntime accepts externally owned messages and conversion logic. Handlers enable send, edit, regenerate, cancel, and other capabilities individually. Streaming updates the external message state. Attachments have an adapter contract. Sending while running is disabled by default unless queue behavior is provided. [ExternalStoreRuntime](https://www.assistant-ui.com/docs/runtimes/custom/external-store).

Inference: this is the clearest documented route for retaining Curia's timeline transport while using a conversation library. Do not enable regenerate or cancel merely because a control exists. Validate their meaning against take-back and harness control. Shared drafts, multiple clients, timeline resets, and first-answer-wins cards need Curia-specific adapters and tests. Managed Assistant Cloud is optional, so adopting the UI needn't introduce another persistence service. Styling can use copied shadcn components or custom primitives. [assistant-ui repository](https://github.com/assistant-ui/assistant-ui).

### React Flow

React Flow provides keyboard-focusable nodes and edges, configurable accessibility labels, focus-driven viewport movement, and screen-reader announcements. Custom interactive content still needs appropriate semantics. Its theming supports CSS variables and dark/light modes. [Accessibility](https://reactflow.dev/learn/advanced-use/accessibility), [theming](https://reactflow.dev/learn/customization/theming).

Inference: use it only if graph navigation improves understanding of the full plan and dependencies. Keep a readable outline alternative for small screens and nonvisual use. Separate viewport selection from roadmap mutations. Automatic layout, edge meaning, collapsed groups, stable positions across refreshes, and handling large plans require explicit decisions. This investigation didn't establish an automatic-layout package or measure rendering performance. The repository's basic API requires node positions; it doesn't infer Curia's plan layout. [React Flow repository](https://github.com/xyflow/xyflow).

## License and maintenance boundaries

The first-party licenses differ:

| Project | License for inspected project | Maintenance consequence |
| --- | --- | --- |
| shadcn/ui | [MIT](https://github.com/shadcn-ui/ui/blob/main/LICENSE.md) | Keep required notices with copied source; track upstream fixes for owned components. |
| AI Elements | [Apache-2.0](https://github.com/vercel/ai-elements/blob/main/LICENSE) | Preserve applicable license and notice obligations when adapting component source. |
| assistant-ui | [MIT](https://github.com/assistant-ui/assistant-ui) | Maintain runtime compatibility and Curia adapters; hosted services are a separate choice. |
| React Flow | [MIT](https://github.com/xyflow/xyflow) | Maintain package compatibility and custom nodes; paid offerings are separate from the core license. |

This records project licenses, not a transitive dependency audit or legal opinion. Verify the exact installed dependency tree and any copied assets before release.

## Decisions the next prototype should inform

1. Compare conversation-led and attention-led shells using the same real Curia work: collaborate with an agent, shape a roadmap, find the full plan, and resume an interrupted session.
2. Test a long transcript with a typed decision card, answered receipt, reconnect, and shared draft. Compare presentation-only components with an external-store runtime using those cases.
3. Compare a readable plan outline with a dependency canvas. Include a plan too large to fit on one screen and a phone viewport.
4. Check keyboard operation, focus after navigation, screen-reader announcements, mobile composer behavior, and theme contrast. These are acceptance criteria, not verified library properties.
5. Decide build and asset packaging before treating either prototype as production code. Preserve the service boundary and replace obsolete VM assertions with behavior tests.

## Limits

This bounded investigation reviewed first-party documentation, repository licenses, and local code. It didn't install packages, build a prototype, benchmark bundles, run accessibility tools, or change production code. No versions are recommended. The React Flow layout guide failed to load during research, so no layout-engine comparison is claimed. Mobile suitability remains a prototype question for every candidate.
