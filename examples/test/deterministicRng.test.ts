import { describe, it, expect } from 'vitest'
import { makeRng, hashToSeed, randInt, pickWeighted, verifyRun } from '../src/deterministicRng'

describe('deterministic RNG', () => {
  it('produces an identical stream for an identical seed', () => {
    const a = makeRng(12345)
    const b = makeRng(12345)
    const left = Array.from({ length: 1000 }, () => a())
    const right = Array.from({ length: 1000 }, () => b())
    expect(left).toEqual(right)
  })

  it('diverges for neighbouring seeds', () => {
    const a = makeRng(1)
    const b = makeRng(2)
    expect(a()).not.toBe(b())
  })

  it('stays inside [0, 1)', () => {
    const rng = makeRng(hashToSeed('relicworn'))
    for (let i = 0; i < 100_000; i++) {
      const v = rng()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  it('randInt is inclusive on both ends and never escapes the range', () => {
    const rng = makeRng(7)
    const seen = new Set<number>()
    for (let i = 0; i < 20_000; i++) seen.add(randInt(rng, 1, 6))
    expect([...seen].sort()).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('pickWeighted respects the weights within tolerance', () => {
    const rng = makeRng(99)
    const entries = [
      { value: 'common', weight: 80 },
      { value: 'rare', weight: 15 },
      { value: 'legendary', weight: 5 },
    ]
    const tally: Record<string, number> = { common: 0, rare: 0, legendary: 0 }
    const N = 200_000
    for (let i = 0; i < N; i++) tally[pickWeighted(rng, entries)]++
    expect(tally.common / N).toBeCloseTo(0.8, 2)
    expect(tally.rare / N).toBeCloseTo(0.15, 2)
    expect(tally.legendary / N).toBeCloseTo(0.05, 2)
  })

  it('never returns undefined on the floating-point tail', () => {
    // A roll that lands a hair under `total` used to fall through the loop.
    const rigged = () => 1 - Number.EPSILON
    const entries = [
      { value: 'a', weight: 0.1 },
      { value: 'b', weight: 0.2 },
    ]
    expect(pickWeighted(rigged, entries)).toBeDefined()
  })

  it('hashToSeed is stable and spreads similar strings apart', () => {
    expect(hashToSeed('run-0001')).toBe(hashToSeed('run-0001'))
    expect(hashToSeed('run-0001')).not.toBe(hashToSeed('run-0002'))
  })
})

describe('replay verification', () => {
  // A toy simulation standing in for the real one: it must be pure and depend on
  // nothing but the input.
  const simulate = (input: { seed: number; heroId: string; actions: readonly { tick: number; kind: string }[] }) => {
    const rng = makeRng(input.seed)
    let kills = 0
    for (const a of input.actions) if (a.kind === 'attack' && rng() > 0.3) kills++
    return { floorReached: 1 + Math.floor(kills / 5), kills, score: kills * 100 }
  }

  const input = {
    seed: hashToSeed('run-42'),
    heroId: 'huntress',
    actions: Array.from({ length: 40 }, (_, i) => ({ tick: i, kind: 'attack' })),
  }

  it('accepts an honest result', () => {
    const honest = simulate(input)
    expect(verifyRun(input, honest, simulate).ok).toBe(true)
  })

  it('rejects an inflated score and names the field', () => {
    const honest = simulate(input)
    const cheated = { ...honest, score: honest.score + 10_000 }
    const verdict = verifyRun(input, cheated, simulate)
    expect(verdict.ok).toBe(false)
    expect(verdict.mismatch).toContain('score')
  })
})
