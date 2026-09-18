/**
 * Single-flight save queue with coalescing and server-directed backoff.
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * A Telegram Mini App saves progress constantly: after a floor, after a level-up,
 * after a purchase. The naive version fires a request per event. In production that
 * produced three distinct failures:
 *
 *   1. 409 Conflict storms. Two saves in flight at once, both built on revision N.
 *      The first wins, the second is rejected, the client retries it — still on
 *      revision N — and loops.
 *   2. 429 rate-limit pile-ups. Every rejected save retried immediately with no
 *      compression, so a burst of six events became a burst of six retries.
 *   3. Lost progress. The retry re-sent the *stale* snapshot it was created with,
 *      overwriting newer state the player had already earned.
 *
 * THE CONTRACT
 * ------------
 *   - At most ONE save is in flight at any moment.
 *   - Everything queued behind the in-flight save collapses into a single pending
 *     slot. Ten events during one request produce one follow-up request.
 *   - The follow-up always sends the NEWEST state, never the state that was queued.
 *   - A rejection is not retried blindly: `Retry-After` from the server is honoured,
 *     and a conflict re-reads the authoritative revision before trying again.
 *
 * The transport is injected, so this file has no knowledge of any endpoint, header
 * or credential — that is the point of the seam.
 */

export interface SaveTransport<S> {
  /** Resolves with the new revision, or throws a SaveError. */
  push(state: S, baseRevision: number): Promise<{ revision: number }>
  /** Authoritative read, used to recover from a revision conflict. */
  pull(): Promise<{ state: S; revision: number }>
}

export class SaveError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Seconds the server asked us to wait, if it said so. */
    readonly retryAfterSec?: number,
  ) {
    super(message)
    this.name = 'SaveError'
  }
}

export type SaveOutcome =
  | { kind: 'saved'; revision: number }
  | { kind: 'coalesced' }
  | { kind: 'failed'; error: SaveError }

const CONFLICT = 409
const RATE_LIMITED = 429

export class SaveQueue<S> {
  private inFlight: Promise<void> | null = null
  private pending: S | null = null
  private revision: number
  private waitUntil = 0
  /**
   * Retries spent on the state currently being pushed. Reset whenever the caller
   * supplies new state, because new state deserves a fresh budget.
   *
   * Without this counter a server that answers 409 (or 429) every single time turns
   * the drain loop into an infinite loop: each failure re-queues the state, the loop
   * sees pending work and tries again forever. That is not hypothetical — it is the
   * bug this counter was added to fix, caught by the "does not loop forever" test.
   */
  private retriesSpent = 0

  /** One reconciled retry per state. Beyond that the caller is told it failed. */
  private static readonly MAX_RETRIES = 1

  constructor(
    private readonly transport: SaveTransport<S>,
    startRevision = 0,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {
    this.revision = startRevision
  }

  get currentRevision(): number {
    return this.revision
  }

  /**
   * Request that `state` be persisted.
   *
   * Returns immediately with `coalesced` when a save is already running: the caller
   * is not blocked, and the newest state is guaranteed to be sent by the run that is
   * already scheduled. This is deliberate — the UI must never await the network to
   * stay responsive.
   */
  save(state: S): Promise<SaveOutcome> {
    this.pending = state // newest state always wins
    this.retriesSpent = 0 // fresh state, fresh budget
    if (this.inFlight) return Promise.resolve({ kind: 'coalesced' })
    return this.drain()
  }

  /** Resolves once nothing is in flight. */
  async settled(): Promise<void> {
    while (this.inFlight) await this.inFlight
  }

  private async drain(): Promise<SaveOutcome> {
    let last: SaveOutcome = { kind: 'coalesced' }
    while (this.pending !== null) {
      const state = this.pending
      this.pending = null

      const wait = this.waitUntil - this.now()
      if (wait > 0) await this.sleep(wait)

      const run = this.attempt(state)
      this.inFlight = run.then(
        () => undefined,
        () => undefined,
      )
      try {
        last = await run
      } finally {
        this.inFlight = null
      }
    }
    return last
  }

  /** Re-queue `state` for one more try, if the budget allows it. */
  private requeue(state: S): void {
    if (this.retriesSpent >= SaveQueue.MAX_RETRIES) return
    this.retriesSpent++
    if (this.pending === null) this.pending = state
  }

  private async attempt(state: S): Promise<SaveOutcome> {
    try {
      const { revision } = await this.transport.push(state, this.revision)
      this.revision = revision
      this.retriesSpent = 0
      return { kind: 'saved', revision }
    } catch (err) {
      const e = err instanceof SaveError ? err : new SaveError(String(err), 0)

      if (e.status === RATE_LIMITED || e.retryAfterSec != null) {
        // The server told us how long to stay quiet. Obey it rather than guessing an
        // exponential curve — the server knows its own window.
        this.waitUntil = this.now() + (e.retryAfterSec ?? 1) * 1000
        this.requeue(state)
        return { kind: 'failed', error: e }
      }

      if (e.status === CONFLICT) {
        // Somebody else advanced the revision. Re-read the authoritative one and let
        // the newest state go out on top of it. Exactly ONE reconciliation: retrying
        // on a stale revision is the loop this class exists to prevent.
        const fresh = await this.transport.pull()
        this.revision = fresh.revision
        this.requeue(state)
        return { kind: 'failed', error: e }
      }

      // Anything else (5xx, offline, parse failure) is surfaced, not retried blindly.
      // The next real state change will schedule the next attempt.
      return { kind: 'failed', error: e }
    }
  }
}
