# Atlas action lifecycle prototype

This throwaway prototype answers: How should optimistic, acknowledged, progressing, refused, and failed Actions look and behave in Atlas?

Run `./run.sh`, then open `http://127.0.0.1:9018/?variant=A`.

## Variants

- `A`, Context first: Every phase stays beside the control and target that it affects.
- `B`, Persistent action shelf: Controls stay compact while one cross-screen shelf carries active and recent Actions.
- `C`, Focused evidence timeline: Selecting an Action opens its complete local and shared evidence history.

All mutations and daemon evidence are stubbed. No control calls Curia.

The evidence lab exposes lifecycle terms so reviewers can force each case. The proposed Atlas UI doesn't expose Action IDs, conflict keys, revisions, or repeated lifecycle labels.

## Review prompts

1. Which variant should become the baseline?
2. Which part of another variant should the baseline borrow?
3. After two independent presses, is each pending target clear without making the page feel globally busy?
4. On refusal or failure, is the recovery visible in the place where you acted?
5. After navigation or refresh, can you tell which work remains shared and which state was only local?
6. Does destructive pending treatment remain truthful without making completion look certain?

## Verdict

Use variant A as the Atlas baseline. Show one immediate status at the affected control, keep the target visibly pending, and add contextual text only for meaningful progress, ambiguity, refusal, or failure. Don't repeat “pending,” or expose Action IDs, conflict keys, or revisions.

Keep variant C as an internal explanation of the lifecycle. Its separation between the Action list, selected Action, and evidence history makes the state model understandable, but the full timeline isn't the everyday user interface.

Variant B isn't the baseline. A later implementation may use a restrained persistent indicator when accepted work survives navigation, without adopting the full shelf.
