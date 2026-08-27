# Maps full-rail prototype

This throwaway prototype asks how map selection should reveal the complete rail while every progress
segment keeps its exact share of the underlying item count.

Run it from the repository root:

```sh
./prototypes/maps-screen/run.sh
```

Open <http://127.0.0.1:9013/?variant=C>. Use the floating controls or the Left Arrow and Right Arrow
keys to compare these variants:

- `A`: Keep the map list and show a sticky, complete rail beside it.
- `B`: Expand the complete rail inside the selected map.
- `C`: Combine a persistent map index with larger selectors, miniature rails, and a focused full rail.

Each nonzero segment spans exactly one grid track per item. Zero-count stages don't consume width.
The prototype lists zero-count stages under the band and keeps them in the complete detail rail.

The current vocabulary is `done`, `running`, `frontier`, `blocked`, and `fog`. Frontier detail rows
use two lines and expose a static **Start** button. The button doesn't dispatch real work.
