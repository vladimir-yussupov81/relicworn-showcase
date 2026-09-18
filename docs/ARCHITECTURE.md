# RELICWORN — architecture notes

Written for readers who want to know *why* the pieces sit where they do. It describes the
production system at a level that is safe to publish: structure and reasoning, no endpoints,
schemas, keys or anti-abuse logic.

---

## 1. The constraint that shaped everything

RELICWORN runs inside the Telegram in-app browser. That single fact dictates most of the
architecture:

- **The whole game is a web page.** There is no installer to put 400 MB of assets on the
  device. Everything streams, so the asset budget is a load-time budget.
- **One WebGL context, and it can be taken away.** Mobile browsers drop GPU contexts under
  memory pressure. Anything that assumes a context lives forever is a crash waiting for a
  low-end phone.
- **The session can end at any moment.** A player closes the chat mid-run. Progress has to
  be durable at every step, not at the end.
- **Portrait, one thumb, 372×682 CSS pixels.** This is the actual canvas. Every readability
  decision is made at that size.

## 2. The simulation / presentation split

The load-bearing boundary in the codebase:

```
          writes                     reads
  input ──────────►  SIMULATION  ◄────────── RENDERER
                     (pure TS)               (Three.js)
                          │
                          │ same module, no GPU
                          ▼
                      SERVER REPLAY
```

**The simulation is pure.** It has no renderer, no DOM, no `Date.now()`, no `Math.random()`.
It advances on a fixed tick and takes randomness as an explicit parameter — a seeded
generator threaded through the call graph.

This costs real ergonomics. Passing an `rng` into every function that needs a coin flip is
more verbose than calling `Math.random()`, and it is a discipline that has to be enforced,
because a single stray `Math.random()` deep in a loot table silently breaks replay for
everyone.

What it buys:

1. **The server can verify a run.** The client submits a seed plus its input stream, not a
   score. The server replays it with the same code and compares.
2. **Frame drops cannot change outcomes.** The renderer can miss frames; the simulation
   still advances by whole ticks.
3. **Bugs are reproducible.** A bad run is a seed. Paste the seed, get the bug.

Determinism, replay compatibility and the save format are treated as **frozen contracts**.
Changing one is a migration with a version bump, not an edit.

## 3. The save path

Progress loss is the bug players never forgive, so the save path gets its own contract.

The naive version — fire a request per event — produced three distinct production failures:

| Failure | Cause |
|---|---|
| 409 conflict storms | Two writes in flight built on the same revision; the loser retried on the same stale revision, forever |
| 429 pile-ups | Every rejection retried instantly with no compression, turning a burst of events into a burst of retries |
| Lost progress | A retry re-sent the snapshot it was *created* with, overwriting newer state |

The contract that replaced it:

- at most **one** write in flight;
- everything queued behind it collapses into **one** pending slot;
- the follow-up carries the **newest** state, never the queued one;
- `Retry-After` from the server is obeyed rather than guessed at;
- a revision conflict triggers **exactly one** authoritative re-read and retry, with a
  retry budget so a permanently-conflicting server cannot spin the queue.

Writes are compare-and-swap on a revision number: the client says "I am writing on top of
revision N", and the server rejects it if N is no longer current. The client, not the
server, resolves the conflict, because only the client knows what the player just did.

A runnable model of this is in
[`examples/src/singleFlightSave.ts`](../examples/src/singleFlightSave.ts).

## 4. Memory and the asset cache

The 3D asset cache was originally capped by **entry count**. That number says nothing about
memory: a 200 KB prop and a 40 MB rigged hero both count as one. A single run could hold
well over a gigabyte of GPU memory under a cap that looked conservative.

The cache is now capped in **bytes**, which introduced two follow-on problems worth naming:

1. **Eviction of visible assets.** Fixed with counted leases — an asset referenced by the
   current room or the roster screen cannot be evicted, and a double release must not free a
   lease somebody else still holds.
2. **Thrashing.** When live entries alone exceed the budget, evicting and re-uploading every
   frame is worse than being over budget. The cache reports pressure and stops, so the caller
   can lower quality instead.

Related lessons that are easy to get wrong:

- **Container format is not memory.** Converting PNG to WebP reduces download size. It does
  not reduce a single byte of VRAM — only a GPU-compressed format does.
- **Texture caps belong in device pixels.** The player has a 2× display; a cap in CSS pixels
  is a cap in the wrong unit.
- **Disposing a renderer on a reused canvas leaks.** Recreating a WebGL renderer on the same
  canvas element leaked hundreds of megabytes of video memory across screen transitions.

## 5. Rendering

- A custom render loop over Three.js, not a general-purpose engine: the game needs a
  specific camera, a specific lighting model and a specific budget, and a general engine
  charges for the parts it does not use.
- **Authored floor plates.** Rooms are built as single unlit plates with authored detail
  rather than tiled geometry. Shading is spent only where there is real geometry; depth
  comes from objects standing *on* the plate, because displacing the plate itself resamples
  the authored detail away.
- The camera is frozen at a chosen pitch for portrait. Fixing it early means every visual
  decision downstream is made in the frame the player actually sees.

## 6. Asset pipeline

```
Blender Python source
        │  headless Blender, factory startup, scripted
        ▼
    deterministic build  ──►  manifest + hash
        │
        ▼
      GLB  ──►  optimisation pass (gltf-transform)  ──►  runtime
```

Three rules make this reviewable:

- **The build is scripted, never hand-saved.** The `.blend` is an artefact of the script, not
  the source of truth. Re-running the script reproduces the binary.
- **Provenance is recorded per asset** — generator, retopology, textures, licence, build
  script — so any runtime asset can be traced back to what produced it.
- **The optimised derivative is the default.** An optimisation hidden behind an optional flag
  is not banked; the flag closes the *original*, not the improvement.

## 7. Visual verification

Visual work cannot be signed off by reading a diff, so it is verified by capture:

- a Playwright harness drives the real game on a real GPU,
- waits for a settled frame,
- captures fixed camera positions,
- measures the pixels — coverage, contrast, screen-space share.

The instrument itself needs calibration and is documented as such: a luminance metric will
reject a colour it under-weights, a frame median hides a dark material, and a threshold is
only valid inside the lighting profile it was calibrated in. **A captured frame is an
instrument, not a judge** — the final verdict on how the game feels comes from playing it.

## 8. Testing

| Layer | Approach |
|---|---|
| Simulation rules | Unit tests over pure functions, seeded and exact |
| Replay compatibility | A frozen set of runs that must reproduce byte-identically |
| Save/load | Fault injection: conflicts, rate limits, gateway timeouts, offline |
| UI flows | Playwright end-to-end over the real build |
| Visual | Frame capture with measured, calibrated thresholds |
| Performance | Captured traces on a real device profile, not synthetic benchmarks |

286 test files. The distribution is deliberately uneven: the simulation and the save path
carry most of them, because those are the two places where a silent bug costs a player their
progress or their score.

## 9. Release process

- Preview build first, on its own URL, reachable from Telegram through a launch token.
- Production behind a feature flag where the change is risky.
- **A named rollback commit is recorded before the deploy**, not looked up during the
  incident.
- Production identity is confirmed by finding the new code's own strings in the live bundle
   — a bundle hash does not match a local build of the same commit, so the hash proves
  nothing.
