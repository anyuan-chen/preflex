/**
 * Windowed aggregation types and ring buffer.
 *
 * Each Window captures a 30-second slice of cluster activity,
 * computed from deltas between consecutive ES API polls.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Window {
  timestamp: number;          // epoch ms — end of this window
  duration: 30;               // seconds (fixed)
  indices: Record<string, IndexWindow>;
  cluster: ClusterSnapshot;
  nodes: NodeWindow[];
}

export interface IndexWindow {
  queryCount: number;         // delta from last window
  queryRate: number;          // qps (queryCount / 30)
  avgLatency: number;         // ms (from cumulative query_time / query_count deltas)
  errorCount: number;
}

export interface ClusterSnapshot {
  health: "green" | "yellow" | "red";
  nodes: number;
  activeShards: number;
  unassignedShards: number;
}

export interface NodeWindow {
  name: string;
  cpu: number;                // 0-100
  heapPercent: number;        // 0-100
  searchThreadPoolActive: number;
  searchThreadPoolQueue: number;
  searchThreadPoolRejected: number;
}

// ---------------------------------------------------------------------------
// Ring buffer — fixed capacity, O(1) push, iterable newest→oldest
// ---------------------------------------------------------------------------

export class RingBuffer<T> {
  private buf: (T | undefined)[];
  private head = 0;   // next write position
  private count = 0;

  constructor(public readonly capacity: number) {
    this.buf = new Array(capacity);
  }

  push(item: T): void {
    this.buf[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  /** Most recent N items, newest first. */
  latest(n?: number): T[] {
    const take = Math.min(n ?? this.count, this.count);
    const result: T[] = [];
    for (let i = 0; i < take; i++) {
      const idx = (this.head - 1 - i + this.capacity) % this.capacity;
      result.push(this.buf[idx] as T);
    }
    return result;
  }

  get length(): number {
    return this.count;
  }

  clear(): void {
    this.buf = new Array(this.capacity);
    this.head = 0;
    this.count = 0;
  }
}
