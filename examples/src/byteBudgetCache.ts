/**
 * LRU cache with a BYTE budget and eviction leases.
 *
 * THE LESSON BEHIND IT
 * --------------------
 * The 3D asset cache was originally capped by entry count — 48 GLTF models. That
 * number says nothing about memory: a 200 KB prop and a 40 MB rigged hero both
 * count as "one". A single dungeon run could hold well over a gigabyte of GPU
 * memory under a cap that looked conservative on paper.
 *
 * Replacing the count with a byte budget fixed the ceiling, but introduced a
 * second failure immediately: the cache would evict a model that was still being
 * rendered. Hence leases — an asset in use by the current room cannot be evicted,
 * no matter how cold it looks.
 *
 * And the third failure, which is the interesting one: when live entries exceed
 * the budget the cache must NOT thrash, evicting and re-uploading every frame.
 * It reports pressure and gives up instead. A cache that cannot meet its budget
 * should say so, not burn the frame trying.
 */

export interface CacheEntry<V> {
  readonly value: V
  readonly bytes: number
}

export interface EvictionReport {
  readonly evicted: number
  readonly bytesFreed: number
  /** True when the budget could NOT be met because live entries hold it open. */
  readonly underPressure: boolean
}

export class ByteBudgetCache<K, V> {
  private readonly map = new Map<K, CacheEntry<V>>() // Map preserves insertion order
  private readonly leases = new Map<K, number>()
  private bytes = 0

  constructor(
    private readonly budgetBytes: number,
    private readonly onEvict?: (key: K, value: V) => void,
  ) {}

  get size(): number {
    return this.map.size
  }

  get bytesUsed(): number {
    return this.bytes
  }

  /** Read and mark as most-recently-used. */
  get(key: K): V | undefined {
    const hit = this.map.get(key)
    if (!hit) return undefined
    this.map.delete(key) // re-insert to move to the MRU end
    this.map.set(key, hit)
    return hit.value
  }

  has(key: K): boolean {
    return this.map.has(key)
  }

  set(key: K, value: V, bytes: number): EvictionReport {
    const existing = this.map.get(key)
    if (existing) {
      this.bytes -= existing.bytes
      this.map.delete(key)
    }
    this.map.set(key, { value, bytes })
    this.bytes += bytes
    // The entry that was just requested is never the one to drop — it is the most
    // recently used by definition, and evicting it would mean the caller has to
    // re-upload it on the very next frame.
    return this.enforceBudget(key)
  }

  /**
   * Pin an entry for as long as it is on screen. Leases are counted, because the
   * same hero model can be referenced by the roster screen and the run at once.
   */
  acquire(key: K): () => void {
    this.leases.set(key, (this.leases.get(key) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return // idempotent: double-release must not free a live asset
      released = true
      const n = (this.leases.get(key) ?? 1) - 1
      if (n <= 0) this.leases.delete(key)
      else this.leases.set(key, n)
    }
  }

  isLeased(key: K): boolean {
    return (this.leases.get(key) ?? 0) > 0
  }

  private enforceBudget(protectKey?: K): EvictionReport {
    let evicted = 0
    let bytesFreed = 0
    if (this.bytes <= this.budgetBytes) {
      return { evicted, bytesFreed, underPressure: false }
    }
    // Map iteration order is insertion order, so the front is the coldest entry.
    for (const key of [...this.map.keys()]) {
      if (this.bytes <= this.budgetBytes) break
      if (key === protectKey) continue
      if (this.isLeased(key)) continue
      const entry = this.map.get(key)!
      this.map.delete(key)
      this.bytes -= entry.bytes
      bytesFreed += entry.bytes
      evicted++
      this.onEvict?.(key, entry.value)
    }
    // Over budget with nothing left to drop: every remaining entry is in use.
    // Report it so the caller can lower quality instead of thrashing.
    return { evicted, bytesFreed, underPressure: this.bytes > this.budgetBytes }
  }
}
