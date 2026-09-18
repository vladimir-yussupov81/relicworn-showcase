/**
 * Deterministic seeded PRNG — the foundation of server-verifiable runs.
 *
 * WHY THIS EXISTS
 * ---------------
 * RELICWORN is a leaderboard game, so "the client says it scored 40,000" is not
 * evidence. Every run is generated from a seed: given the same seed and the same
 * input stream, the simulation must produce a byte-identical result on the player's
 * phone and on the server that later re-runs it.
 *
 * That rules out `Math.random()` and `Date.now()` anywhere inside the simulation.
 * Randomness becomes an explicit parameter that is threaded through the call graph,
 * which is more verbose but makes the whole run reproducible from 8 bytes.
 *
 * mulberry32 was chosen over xorshift/PCG because it is ~10 lines, has no 64-bit
 * arithmetic (JS bitwise ops are 32-bit, so 64-bit generators need BigInt and get
 * slow), and passes gjrand/PractRand well beyond what a dungeon crawler needs.
 *
 * This file is a standalone extract of the pattern used in production.
 */

export type RNG = () => number // float in [0, 1)

/** mulberry32 — 32-bit state, no dependencies, identical across engines. */
export function makeRng(seed: number): RNG {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** FNV-1a — turns a run id or user id into a 32-bit seed. */
export function hashToSeed(str: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export function randInt(rng: RNG, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1)) // inclusive both ends
}

export function pick<T>(rng: RNG, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]
}

/**
 * Weighted pick. Used for loot tables and room selection.
 *
 * Note the guard on the tail: floating point means the accumulated weight can end
 * up a hair below `total`, and without the fallback a roll of 0.9999999 would fall
 * through the loop and return undefined — a bug that only shows up once every few
 * hundred thousand runs, which is exactly the kind that reaches production.
 */
export function pickWeighted<T>(rng: RNG, entries: readonly { value: T; weight: number }[]): T {
  let total = 0
  for (const e of entries) total += e.weight
  let roll = rng() * total
  for (const e of entries) {
    roll -= e.weight
    if (roll < 0) return e.value
  }
  return entries[entries.length - 1].value
}

// ---------------------------------------------------------------------------
// Replay verification
// ---------------------------------------------------------------------------

export interface RunInput {
  readonly seed: number
  readonly heroId: string
  /** Player actions, quantised to simulation ticks. */
  readonly actions: readonly { tick: number; kind: string }[]
}

export interface RunResult {
  readonly floorReached: number
  readonly kills: number
  readonly score: number
}

/**
 * The shape of the check the server performs on a submitted score.
 *
 * The client sends the *input*, not the outcome. The server replays it with the
 * same pure simulation and compares. A mismatch does not mean "cheater" — it also
 * fires when client and server drift apart on a rules change, which is why the
 * rule version is part of the run and why the simulation is frozen behind a
 * migration contract.
 */
export function verifyRun(
  input: RunInput,
  claimed: RunResult,
  simulate: (input: RunInput) => RunResult,
): { ok: boolean; replayed: RunResult; mismatch: string[] } {
  const replayed = simulate(input)
  const mismatch: string[] = []
  if (replayed.floorReached !== claimed.floorReached) mismatch.push('floorReached')
  if (replayed.kills !== claimed.kills) mismatch.push('kills')
  if (replayed.score !== claimed.score) mismatch.push('score')
  return { ok: mismatch.length === 0, replayed, mismatch }
}
