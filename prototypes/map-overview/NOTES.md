# Map overview prototype

Throwaway prototype for [Choose a map overview for the full plan and its execution](https://github.com/alp82/curia/issues/1022).
It holds four forms of the Maps page inside the variant D shell chosen on
[Choose between conversation-led and attention-led Curia workspaces](https://github.com/alp82/curia/issues/1021).
The page is one file, with static mock data and no persistence.

Run it from the repository root:

```sh
cd prototypes/map-overview && python3 -m http.server 9022 --bind 127.0.0.1
```

Open <http://127.0.0.1:9022/?variant=I>. To switch the variant, use the floating bar or the Left Arrow and Right Arrow keys.
Press `d` to switch between desktop and phone, `1` to `7` to switch the plan, `r` to toggle reshape, and `m` to switch the map selector between a list and a menu.

| Variant | Name | What it shows first |
| --- | --- | --- |
| A | Lanes | Where each ticket stands: done, active, ready, blocked, not yet specified |
| B | Route | Phases in order (Decide, Prototype, Build, Ship), then the destination, with a marker for the live stretch |
| C | Outline | The map as a readable page: changes, needs you, working now, up next, later by blocker, fog, decided |
| D | Focus | A strip of every ticket as a square, then one ticket with what it waits on and what it unlocks |

## Round 2

The operator saw potential in D and asked for more variations. Round 2 drops the invented failed state: a ticket is closed, or open and working, needing an answer, needing a review, ready, or blocked. A dead session releases its claim, which shows as a change. The stacked bars became squares, and the horizontal map strip became a list or a menu.

| Variant | Name | What it shows first |
| --- | --- | --- |
| D | Focus | A square per ticket by phase, then the selected ticket between what it waits on and what it unlocks |
| E | Layers | The squares in dependency order, with lines to blockers; the selected ticket's lines are bright |
| F | Board | Every open ticket as a titled tile by phase; closed tickets shrink to squares; a side panel for the selected one |
| G | Path | The selected ticket, then the longest route from it to the destination |
| H | Split | A text list by phase beside the selected ticket and the latest from its conversation |

The arrows cycle D to H. A to C stay reachable by `?variant=`.

## Round 3

The operator found E interesting and asked for simple variations in the register of the sidebar. Maps move into the sidebar. The header is one sentence. Two colors carry meaning: amber for needs you and blue for working. Selecting a ticket shows one bar at the bottom with its main action and a menu, and it highlights related tickets. There is no reshape mode.

| Variant | Name | What it shows first |
| --- | --- | --- |
| I | Graph | E's squares and lines, quieter, titles on hover and in the bar |
| J | Waves | Open tickets in columns: now, next, after that, later |
| K | List | The same waves in one column |
| L | Graph + list | The graph, then titles for now and next |

The arrows cycle E, then I to L.

The seven plans differ in size and shape:

1. Large and mixed: decisions, build, and ship on one map (32 tickets).
2. Small and nearly done.
3. Wide: one question fans out to nine parallel research tickets, then fans back in.
4. Deep: an 11-step chain with a failure in the middle.
5. and 6. Split: a planning map and its child build map.
7. Fresh and foggy: two tickets, most of the route not charted.

## Known limits of the mock

- Nothing posts to GitHub. Reshape changes last until reload.
- The conversation is a stub with a back button.
