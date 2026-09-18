import { describe, it, expect, vi } from 'vitest'
import { ByteBudgetCache } from '../src/byteBudgetCache'

const MB = 1024 * 1024

describe('ByteBudgetCache', () => {
  it('evicts by bytes, not by entry count', () => {
    const cache = new ByteBudgetCache<string, string>(10 * MB)
    cache.set('small-a', 'a', 1 * MB)
    cache.set('small-b', 'b', 1 * MB)
    cache.set('huge', 'h', 9 * MB)
    // A count-capped cache would have kept all three. A byte-capped one must not.
    expect(cache.bytesUsed).toBeLessThanOrEqual(10 * MB)
    expect(cache.has('huge')).toBe(true)
    expect(cache.has('small-a')).toBe(false)
  })

  it('evicts the least recently used first', () => {
    const cache = new ByteBudgetCache<string, string>(3 * MB)
    cache.set('a', 'a', 1 * MB)
    cache.set('b', 'b', 1 * MB)
    cache.set('c', 'c', 1 * MB)
    cache.get('a') // 'a' is now the hottest, 'b' the coldest
    cache.set('d', 'd', 1 * MB)
    expect(cache.has('b')).toBe(false)
    expect(cache.has('a')).toBe(true)
  })

  it('never evicts a leased entry', () => {
    const cache = new ByteBudgetCache<string, string>(2 * MB)
    cache.set('hero', 'h', 1 * MB)
    const release = cache.acquire('hero')
    cache.set('room', 'r', 1 * MB)
    cache.set('boss', 'b', 1 * MB)
    expect(cache.has('hero')).toBe(true) // still on screen
    release()
    cache.set('prop', 'p', 1 * MB)
    expect(cache.has('hero')).toBe(false) // free to go once released
  })

  it('counts leases so a shared asset survives one release', () => {
    const cache = new ByteBudgetCache<string, string>(1 * MB)
    cache.set('hero', 'h', 1 * MB)
    const releaseRoster = cache.acquire('hero')
    const releaseRun = cache.acquire('hero')
    releaseRoster()
    expect(cache.isLeased('hero')).toBe(true)
    releaseRun()
    expect(cache.isLeased('hero')).toBe(false)
  })

  it('treats a double release as one release', () => {
    const cache = new ByteBudgetCache<string, string>(1 * MB)
    cache.set('hero', 'h', 1 * MB)
    const a = cache.acquire('hero')
    const b = cache.acquire('hero')
    a()
    a() // buggy caller releasing twice must not free the lease held by `b`
    expect(cache.isLeased('hero')).toBe(true)
    b()
    expect(cache.isLeased('hero')).toBe(false)
  })

  it('reports pressure instead of thrashing when live entries exceed the budget', () => {
    const cache = new ByteBudgetCache<string, string>(2 * MB)
    cache.set('a', 'a', 1 * MB)
    cache.acquire('a')
    cache.set('b', 'b', 1 * MB)
    cache.acquire('b')
    const report = cache.set('c', 'c', 1 * MB)
    cache.acquire('c')
    expect(report.underPressure).toBe(true)
    expect(report.evicted).toBe(0)
  })

  it('calls the disposer exactly once per eviction', () => {
    const onEvict = vi.fn()
    const cache = new ByteBudgetCache<string, string>(1 * MB, onEvict)
    cache.set('a', 'a', 1 * MB)
    cache.set('b', 'b', 1 * MB)
    expect(onEvict).toHaveBeenCalledTimes(1)
    expect(onEvict).toHaveBeenCalledWith('a', 'a')
  })

  it('does not double-count bytes when a key is overwritten', () => {
    const cache = new ByteBudgetCache<string, string>(10 * MB)
    cache.set('a', 'v1', 3 * MB)
    cache.set('a', 'v2', 1 * MB)
    expect(cache.bytesUsed).toBe(1 * MB)
    expect(cache.size).toBe(1)
  })
})
