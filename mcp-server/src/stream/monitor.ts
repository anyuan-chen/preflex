/**
 * Monitor — the main loop that ties together:
 *   poll → window → baseline → anomaly detect → invoke agent
 *
 * Uses per-anomaly locking (rule+index+node) so multiple agents can
 * work concurrently on different problems, but two agents won't
 * investigate the same issue at the same time.
 */

import { StreamProcessor } from "./processor.js";
import { AnomalyDetector, anomalyKey, type Anomaly } from "./anomaly.js";
import { createBaseline, updateBaseline, type BaselineState } from "./baseline.js";
import { invokeAgent, type InvocationResult } from "./invoke.js";
import type { Window } from "./window.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MonitorEvent {
  type: "window" | "anomaly" | "invocation";
  timestamp: number;
  window?: Window;
  anomalies?: Anomaly[];
  invocationResult?: InvocationResult;
}

export type MonitorListener = (event: MonitorEvent) => void;

// ---------------------------------------------------------------------------
// Monitor
// ---------------------------------------------------------------------------

export class Monitor {
  readonly processor: StreamProcessor;
  readonly detector: AnomalyDetector;
  readonly baseline: BaselineState;

  private interval: ReturnType<typeof setInterval> | null = null;
  private listeners: MonitorListener[] = [];
  private tickInProgress = false;

  /** Anomaly keys currently being handled or in cooldown. Value = unlock timestamp. */
  private locks = new Map<string, number>();

  /** Cooldown after invocation completes before the same anomaly can re-fire (ms). */
  private cooldownMs = 2 * 60_000; // 2 minutes

  constructor(windowCapacity = 30, cooldownMs?: number) {
    if (cooldownMs !== undefined) this.cooldownMs = cooldownMs;
    this.processor = new StreamProcessor(windowCapacity);
    this.detector = new AnomalyDetector();
    this.baseline = createBaseline();
  }

  /** Subscribe to monitor events. Returns unsubscribe function. */
  on(listener: MonitorListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /**
   * Rapidly seed the baseline by doing burst polls.
   * Each window needs 3 polls; baseline needs 10 windows = 30 polls.
   * Polls 1s apart → ~30s to establish baseline vs 5min at normal rate.
   */
  async seed(): Promise<void> {
    const POLLS_NEEDED = 30; // 3 polls/window * 10 windows
    console.log(`Seeding baseline (${POLLS_NEEDED} rapid polls)...`);
    for (let i = 0; i < POLLS_NEEDED; i++) {
      const window = await this.processor.poll();
      if (window) {
        updateBaseline(this.baseline, window);
        this.emit({ type: "window", timestamp: window.timestamp, window });
      }
      if (i < POLLS_NEEDED - 1) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    console.log(`Baseline seeded: ready=${this.baseline.ready}, windows=${this.baseline.windowCount}`);
  }

  /** Start polling every `intervalMs` (default 10s). */
  start(intervalMs = 10_000): void {
    if (this.interval) return;
    console.log(`Monitor started (poll every ${intervalMs / 1000}s)`);
    this.interval = setInterval(() => this.tick(), intervalMs);
    // First tick immediately
    this.tick();
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      console.log("Monitor stopped");
    }
  }

  /** Which anomaly keys are currently locked or in cooldown (for testing/observability). */
  get activeLocks(): ReadonlyMap<string, number> {
    return this.locks;
  }

  /** Run one poll cycle manually (for testing). */
  async tick(): Promise<void> {
    if (this.tickInProgress) return; // prevent overlapping ticks
    this.tickInProgress = true;
    try {
      const window = await this.processor.poll();
      if (!window) return; // accumulating polls, no window yet

      // Update baseline
      updateBaseline(this.baseline, window);

      // Emit window event
      this.emit({
        type: "window",
        timestamp: window.timestamp,
        window,
      });

      // Detect anomalies
      const recent = this.processor.windows.latest(5);
      const anomalies = this.detector.detect({
        current: window,
        recent,
        baseline: this.baseline,
      });

      if (anomalies.length === 0) return;

      // Emit anomaly event (all detected, including locked ones)
      this.emit({
        type: "anomaly",
        timestamp: Date.now(),
        anomalies,
      });

      // Filter to anomalies not currently locked or in cooldown
      const now = Date.now();
      const actionable = anomalies.filter((a) => {
        const k = anomalyKey(a);
        const until = this.locks.get(k);
        return until === undefined || now >= until;
      });
      if (actionable.length === 0) return;

      // Lock (Infinity = in-flight) and invoke — fire without awaiting so tick() returns fast
      const keys = actionable.map(anomalyKey);
      for (const k of keys) this.locks.set(k, Infinity);
      this.invokeAndUnlock(actionable, recent, keys);
    } catch (err) {
      console.error("Monitor tick error:", err);
    } finally {
      this.tickInProgress = false;
    }
  }

  /**
   * Invoke the agent and release locks when done.
   * Runs in the background — not awaited by tick().
   */
  private async invokeAndUnlock(
    anomalies: Anomaly[],
    recent: Window[],
    keys: string[],
  ): Promise<void> {
    try {
      const result = await invokeAgent(anomalies, recent);
      this.emit({
        type: "invocation",
        timestamp: Date.now(),
        anomalies,
        invocationResult: result,
      });
    } catch (err) {
      console.error("Agent invocation error:", err);
    } finally {
      const cooldownUntil = Date.now() + this.cooldownMs;
      for (const k of keys) this.locks.set(k, cooldownUntil);
    }
  }

  private emit(event: MonitorEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("Monitor listener error:", err);
      }
    }
  }
}
