# First-use prototype

Throwaway prototype for [Choose a simpler first-use and configuration experience](https://github.com/alp82/curia/issues/1024).
It holds four first-use and configuration variants inside the variant D shell chosen on
[Choose between conversation-led and attention-led Curia workspaces](https://github.com/alp82/curia/issues/1021).
The page is one file, with static mock data and no persistence. Nothing talks to GitHub, a provider, or Discord.

Run it from the repository root:

```sh
cd prototypes/first-use && python3 -m http.server 9024 --bind 127.0.0.1
```

Open <http://127.0.0.1:9024/?variant=A>. To switch the variant, use the floating bar or the Left Arrow and Right Arrow keys.
Press `d` to switch between desktop and phone, `o` to switch the first useful outcome, and `r` to reset to a new installation.

## Inputs

From [Which product requirements belong in Curia's first-use path?](https://github.com/alp82/curia/issues/1023) and ADR-0033:
work needs GitHub and one AI login (the Work gate). Discord is optional. Tailscale is a host prerequisite, shown as a status fact.
Orientation is the empty landing page, with no tour. The connection steps and failure copy follow today's Setup cards
(`daemon/assets/dashboard.html`, `docs/operator/integration-setup.md`), shortened.

## Variants

| Variant | Name | First use | Later configuration |
| --- | --- | --- | --- |
| A | Checklist | Two rows, GitHub and AI login, under a disabled prompt box on the landing page. Each row opens its steps in place. | One Settings page with sections. Connections uses the same rows. |
| B | Guide | A focused guide without the sidebar: GitHub, AI login, first task. **Finish later** leaves a banner to resume. | Two destinations: Connections (sign-ins as cards) and Settings (preferences). |
| C | On demand | No setup screen. The prompt box works. Sending the first task opens a sheet for what's missing, then starts the task. | One Settings page with a compact Connections list on top. |
| D | Setup chat | Setup is a conversation with Curia under **Needs you**. Question cards carry each step, and the last card starts the first task. | One Settings page for status. Changing a connection starts a short conversation. |

In every variant, Credentials and Setup stop being destinations. B is the one that keeps a second destination (Connections)
beside Settings, so the operator can judge whether that separation earns its place.

## First useful outcome

The switch on the bar and in the side panel changes the suggested first task in every variant:

- **Test run first.** A two-ticket map in the watched repository. One agent adds a README line, the next removes it.
  The operator answers one question and approves two pull requests.
- **Task first.** A small real change: a setup section for the README, one pull request to review.

## Scenarios

The side panel sets the mock state for each step:

1. New installation: open, create the GitHub App, choose repositories, GitHub verified.
2. GitHub only: land, open Maps, try to start a task.
3. Failed verification: the GitHub App isn't installed; the AI sign-in is refused.
4. First useful outcome: work can start, start it, it needs you, finished, back to the landing page.
5. Coming back later: add Discord, add a second AI provider, an AI sign-in expires mid-task, change watched repositories.
6. Discord failing on an existing installation: land, work continues, fix it.

Free play: the buttons connect and verify with short delays. **GitHub verify fails** and **AI sign-in fails** make the next
verification fail.

## Known limits of the mock

- Links to GitHub, providers, and Discord show a toast.
- The overseer and the repository picker are stubs.
- The first task advances on timers and on your answers.

## Round 2

The operator chose A and found adding a second AI provider convoluted: the second one is easy to miss. In A, the checklist
disappears as soon as the first provider verifies, so the second provider only lives inside the AI login row of Settings.

Round 2 keeps A and varies only how it offers the second provider. Each variant says what the second provider buys, from
`docs/operator/integration-setup.md`: with both, a pull request can be cross-checked on the other provider's model, and every
ticket type runs on the model routing names for it. With one, the cross-check for that provider is refused and some types
move to the preset model.

| Variant | Name | How the second provider shows |
| --- | --- | --- |
| E | Provider rows | OpenAI and Anthropic are rows of their own under **AI logins**. After the first signs in, the other stays in view as optional. The checklist stays until both sign in, you hide it, or the first task starts. |
| F | Follow-up | One **AI login** row. After the first provider verifies, the row asks once: "Do you also have a Claude subscription?" with **Sign in** and **Not now**. |
| G | Ask first | The **AI login** row asks which subscriptions you have, then signs in to each one in turn, one sign-in at a time. |

Settings, Connections shows one row per provider in all three. The arrows cycle E to G; A to D stay reachable by `?variant=`.
Scenario 6, **Two AI providers**, sets each moment.

**Verdict (September 24, 2026):** the operator chose A, Checklist, with E's provider rows for the AI logins, and a one-line
status beside **AI logins**: "At least one required", "Add the other to cross-check pull requests", or "Both signed in".
The Test run is dropped completely: a new operator starts using the app. See the resolution on the ticket.
