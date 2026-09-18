# Standalone examples

Three patterns lifted out of RELICWORN and rewritten to stand on their own. Each one
carries the reasoning that produced it, including the failure that made it necessary.

They are deliberately dependency-free: no framework, no renderer, no network client, no
production endpoint, rule table or credential. What they demonstrate is the shape of the
solution, not the implementation behind it.

| File | Pattern |
|---|---|
| [`src/deterministicRng.ts`](src/deterministicRng.ts) | Seeded PRNG, weighted selection, replay verification of a submitted run |
| [`src/singleFlightSave.ts`](src/singleFlightSave.ts) | Save queue: one write in flight, coalescing, server-directed backoff, one reconciliation per conflict |
| [`src/byteBudgetCache.ts`](src/byteBudgetCache.ts) | LRU cache capped in bytes, with counted leases and honest pressure reporting |

## Running them

```bash
npm install
npm test        # vitest — 24 tests
npm run typecheck
```

## A note on the tests

The tests here are not decoration. Two of the three implementations were changed because a
test in this directory failed:

- `singleFlightSave` looped forever against a server that answered `409` every time — each
  failure re-queued the state and the drain loop never emptied. That is what the retry
  budget exists for, and `does not loop forever on a repeated conflict` is the test that
  pins it.
- `byteBudgetCache` evicted the entry it had just been asked to store, whenever every older
  entry was leased. The fix is to protect the key being inserted and report
  `underPressure` instead, so the caller can drop quality rather than re-upload the same
  asset every frame.

Both are the kind of bug that survives code review and shows up in production a week later.
