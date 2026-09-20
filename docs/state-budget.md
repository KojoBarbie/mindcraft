# State size budget

Decision models bill by input size (Jev: $0.042 per million input tokens, output free) and the loop asks about
once a second, so the size of the state is the main cost lever. At 1.5 s per decision, around the clock:

| state size | per bot per month |
|---:|---:|
| 5,000 tokens (a naive dump) | ~$363 |
| 500 tokens (the budget) | ~$36 |
| 250 tokens (typical, measured below) | ~$18 |

Event-driven decisions (only when something changed, and none while no player is online) cut this by another
order of magnitude.

`compressState()` enforces the budget: if a state is still over `maxTokens` (default 500) it sheds detail in
steps, least important first (animals, failure notes, long inventory and block lists, then history).

## Measured on the dev server

`node scripts/measure_state.js` stages three situations with RCON and measures each view. Token counts are
from `estimateTokens()`, a dependency-free estimate that errs high for compact JSON; the provider's reported
`inputTokens` is the ground truth once a real model is connected (#10, #15). "Uncompressed" is the raw
snapshot (nearest block of every type in range, every entity), which is already far smaller than Mindcraft's
prompt for a chat model.

| scenario | view | tokens (est.) | uncompressed snapshot |
|---|---|---:|---:|
| early game, day, empty inventory | tactical | 69 | 312 |
| early game, day, empty inventory | combat | 35 | 312 |
| early game, day, empty inventory | crafting | 25 | 312 |
| night, under attack | tactical | 208 | 547 |
| night, under attack | combat | 133 | 547 |
| night, under attack | crafting | 114 | 547 |
| late game, inventory full | tactical | 270 | 626 |
| late game, inventory full | combat | 118 | 626 |
| late game, inventory full | crafting | 310 | 626 |

worst case: 310 tokens (budget 500)

Measured 2026-09-21 on Paper 1.21.6, seed `mindcraft-dev`, at spawn.
