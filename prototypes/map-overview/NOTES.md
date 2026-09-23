# Map overview prototype

Throwaway prototype for [Choose a map overview for the full plan and its execution](https://github.com/alp82/curia/issues/1022).
It holds four forms of the Maps page inside the variant D shell chosen on
[Choose between conversation-led and attention-led Curia workspaces](https://github.com/alp82/curia/issues/1021).
The page is one file, with static mock data and no persistence.

Run it from the repository root:

```sh
cd prototypes/map-overview && python3 -m http.server 9022 --bind 127.0.0.1
```

Open <http://127.0.0.1:9022/?variant=L>. To switch the variant, use the floating bar or the Left Arrow and Right Arrow keys.
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

## Round 4

The operator chose L to iterate on. L now has three independent switches in the side panel (keys `t`, `s`, and `w`):

- Ticket type: none, shape (research circle, grilling square, prototype diamond, task hexagon, build pill, deploy triangle), color, letter, or tag.
- State: plain, texture (a check on closed, a pulse on working, a glow on needs you, red stripes on blocked, a cloud for fog), or icon badges.
- Layout: stack, wrap tall columns after five, or also wrap wide plans into rows. Edges that cross rows are dashed.

The settings are in the URL as `tm`, `sm`, and `wm`.

## Round 5

The operator chose color plus letter for the ticket type (grilling is always a green box with a G) and texture for the state, keeping the working pulse. They asked for fog that looks like fog, another look for blocked, and wrapping that reads as grouping. The side panel now switches:

- Fog (`f`): a fog bank of soft noise over ghost boxes, blurred ghost boxes, or a mist that fades the right edge.
- Blocked (`b`): grayed, hollow dashed, hatched over the type color, or a lock badge.
- Layout (`w`): stack, wrap tall steps, or also wrap wide plans into rows. Lines across rows show only for the selected ticket.
- Grouping (`g`): tight gaps inside a step, a soft panel behind each step, or a square block for large steps.

The settings are in the URL as `fm`, `bm`, `wm`, and `gm`.

## Round 6

The operator chose wrap both for the layout and square for the grouping, which are now the defaults. Fog and blocked got new options:

- Fog (`f`): wavy lines inside faint boxes, a wavy area across the fog column, or the same area drifting slowly.
- Blocked (`b`): grayed, a soft thin outline, dark red stripes over the faded type color, or red stripes on gray.

SVG patterns in the shared definitions did not render, so the stripes are drawn as lines clipped to each box.

## Round 7

The operator fixed fog as wavy boxes, with stronger waves, and blocked as red stripes. Layout (wrap both) and grouping (square) were fixed in round 6. The only switch left is the palette (`c`), because vivid looked heavy: vivid, soft (tint with a thin border and a colored letter), tint (no border), letter (neutral box, colored letter), and bar (neutral box, colored left bar). Stripes are lighter on every palette except vivid. The state legend uses empty boxes, so it shows only the state marking.

**Verdict (September 23, 2026):** the operator chose L, Graph + list, with the soft palette, color and letter for type, wavy boxes for fog, red stripes for blocked, wrap both, and square grouping. See the resolution on the ticket.

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
