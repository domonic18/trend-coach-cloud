/**
 * 单实例固定窗口限流。多实例部署前需换成共享存储，否则配额按实例放大。
 */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly windowMs = 60_000,
    private readonly maxKeys = 100_000,
  ) {}

  take(key: string, limit: number): boolean {
    const current = this.now()
    const entry = this.windows.get(key)
    if (entry === undefined || current - entry.start >= this.windowMs) {
      // 随机键可无限增长；到达上限先清过期窗口，仍满则拒绝新键，保住内存。
      if (entry === undefined && this.windows.size >= this.maxKeys) {
        this.prune()
        if (this.windows.size >= this.maxKeys) return false
      }
      this.windows.set(key, { start: current, count: 1 })
      return true
    }
    if (entry.count >= limit) return false
    entry.count += 1
    return true
  }

  prune(): void {
    const current = this.now()
    for (const [key, entry] of this.windows) {
      if (current - entry.start >= this.windowMs) this.windows.delete(key)
    }
  }
}
