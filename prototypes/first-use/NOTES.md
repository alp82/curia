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
