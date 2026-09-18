import { describe, it, expect, vi } from 'vitest'
import { SaveQueue, SaveError, type SaveTransport } from '../src/singleFlightSave'

type State = { score: number }

/**
 * A transport that ALWAYS records every push, whatever behaviour the test injects.
 *
 * The recording has to live in the wrapper rather than in the default `push`,
 * otherwise a test that overrides `push` silently loses the log it is asserting on.
 */
function makeTransport(
  opts: {
    push?: (state: State, baseRevision: number) => Promise<{ revision: number }>
    pull?: () => Promise<{ state: State; revision: number }>
  } = {},
) {
  const pushes: { state: State; baseRevision: number }[] = []
  let revision = 0
  const defaultPush = async (_state: State, _baseRevision: number) => ({ revision: ++revision })
  const defaultPull = async () => ({ state: { score: -1 }, revision })
  const transport: SaveTransport<State> = {
    async push(state, baseRevision) {
      pushes.push({ state, baseRevision })
      return (opts.push ?? defaultPush)(state, baseRevision)
    },
    async pull() {
      return (opts.pull ?? defaultPull)()
    },
  }
  return { transport, pushes }
}

describe('SaveQueue', () => {
  it('sends a single save straight through', async () => {
    const t = makeTransport()
    const q = new SaveQueue(t.transport)
    const out = await q.save({ score: 10 })
    expect(out).toEqual({ kind: 'saved', revision: 1 })
    expect(t.pushes).toHaveLength(1)
  })

  it('keeps at most one request in flight', async () => {
    let inFlight = 0
    let maxConcurrent = 0
    const t = makeTransport({
      async push(state, baseRevision) {
        inFlight++
        maxConcurrent = Math.max(maxConcurrent, inFlight)
        await new Promise((r) => setTimeout(r, 5))
        inFlight--
        return { revision: baseRevision + 1 }
      },
    })
    const q = new SaveQueue(t.transport)
    void q.save({ score: 1 })
    void q.save({ score: 2 })
    void q.save({ score: 3 })
    await q.settled()
    expect(maxConcurrent).toBe(1)
  })

  it('collapses a burst into one follow-up carrying the NEWEST state', async () => {
    const t = makeTransport({
      async push(state, baseRevision) {
        await new Promise((r) => setTimeout(r, 5))
        return { revision: baseRevision + 1 }
      },
    })
    const q = new SaveQueue(t.transport)
    const first = q.save({ score: 1 }) // goes out immediately
    const second = await q.save({ score: 2 }) // queued
    const third = await q.save({ score: 3 }) // replaces the queued one
    expect(second).toEqual({ kind: 'coalesced' })
    expect(third).toEqual({ kind: 'coalesced' })
    await first
    await q.settled()
    // Ten events, two requests: the first and the newest. Never the middle one.
    expect(t.pushes.map((p) => p.state.score)).toEqual([1, 3])
  })

  it('honours Retry-After instead of retrying immediately', async () => {
    const sleep = vi.fn(async () => {})
    let calls = 0
    const t = makeTransport({
      async push(state, baseRevision) {
        calls++
        if (calls === 1) throw new SaveError('slow down', 429, 3)
        return { revision: baseRevision + 1 }
      },
    })
    let clock = 0
    const q = new SaveQueue(t.transport, 0, () => clock, sleep as (ms: number) => Promise<void>)
    await q.save({ score: 5 })
    await q.settled()
    expect(sleep).toHaveBeenCalledWith(3000) // the server's number, not a guess
    expect(calls).toBe(2)
  })

  it('re-reads the authoritative revision after a conflict, then retries once', async () => {
    let calls = 0
    const pull = vi.fn(async () => ({ state: { score: 0 }, revision: 77 }))
    const t = makeTransport({
      async push(state, baseRevision) {
        calls++
        if (calls === 1) throw new SaveError('revision conflict', 409)
        return { revision: baseRevision + 1 }
      },
      pull,
    })
    const q = new SaveQueue(t.transport, 5)
    await q.save({ score: 9 })
    await q.settled()
    expect(pull).toHaveBeenCalledTimes(1)
    // The retry is built on the revision the server gave us, not the stale one.
    expect(t.pushes[1].baseRevision).toBe(77)
    expect(q.currentRevision).toBe(78)
  })

  it('does not loop forever on a repeated conflict', async () => {
    let calls = 0
    const t = makeTransport({
      async push() {
        calls++
        throw new SaveError('revision conflict', 409)
      },
      async pull() {
        return { state: { score: 0 }, revision: calls }
      },
    })
    const q = new SaveQueue(t.transport)
    await q.save({ score: 1 })
    await q.settled()
    expect(calls).toBeLessThanOrEqual(2) // one attempt, one reconciled retry
  })

  it('surfaces a transport failure rather than swallowing it', async () => {
    const t = makeTransport({
      async push() {
        throw new SaveError('gateway timeout', 504)
      },
    })
    const q = new SaveQueue(t.transport)
    const out = await q.save({ score: 1 })
    expect(out.kind).toBe('failed')
    if (out.kind === 'failed') expect(out.error.status).toBe(504)
  })
})
