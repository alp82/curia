# Map overview prototype

Throwaway prototype for [Choose a map overview for the full plan and its execution](https://github.com/alp82/curia/issues/1022).
It holds four forms of the Maps page inside the variant D shell chosen on
[Choose between conversation-led and attention-led Curia workspaces](https://github.com/alp82/curia/issues/1021).
The page is one file, with static mock data and no persistence.

Run it from the repository root:

```sh
cd prototypes/map-overview && python3 -m http.server 9022 --bind 127.0.0.1
```

Open <http://127.0.0.1:9022/?variant=A>. To switch the variant, use the floating bar or the Left Arrow and Right Arrow keys.
Press `d` to switch between desktop and phone, `1` to `7` to switch the plan, and `r` to toggle reshape.

| Variant | Name | What it shows first |
| --- | --- | --- |
| A | Lanes | Where each ticket stands: done, active, ready, blocked, not yet specified |
| B | Route | Phases in order (Decide, Prototype, Build, Ship), then the destination, with a marker for the live stretch |
| C | Outline | The map as a readable page: changes, needs you, working now, up next, later by blocker, fog, decided |
| D | Focus | A strip of every ticket as a square, then one ticket with what it waits on and what it unlocks |

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
