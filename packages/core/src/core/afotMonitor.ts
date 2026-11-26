/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * In-memory request log for the live monitor panel. Stores metadata only
 * (never prompts, tool arguments, or keys).
 */

export type MonitorRequestType = 'llm' | 'poll' | 'tool';

export interface MonitorRequest {
  id: number;
  ts: number;
  type: MonitorRequestType;
  target: string;
  status: string;
  ms?: number;
  tokensIn?: number;
  tokensOut?: number;
}

const MAX_ENTRIES = 50;
let nextId = 1;
let entries: MonitorRequest[] = [];
let lastPollKey = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;

function emit(): void {
  version++;
  for (const l of listeners) {
    try {
      l();
    } catch {
      // listeners must never break the request path
    }
  }
}

export function recordMonitorRequest(
  r: Omit<MonitorRequest, 'id' | 'ts'> & { ts?: number },
): number {
  const id = nextId++;
  entries.push({ ...r, id, ts: r.ts ?? Date.now() });
  if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
  emit();
  return id;
}

export function updateMonitorRequest(
  id: number,
  patch: Partial<Omit<MonitorRequest, 'id'>>,
): void {
  const i = entries.findIndex((e) => e.id === id);
  if (i < 0) return;
  entries[i] = { ...entries[i], ...patch };
  emit();
}

/** Logs a poll only when its status changed since the previous poll of the same target. */
export function recordMonitorPoll(target: string, status: string): void {
  if (lastPollKey.get(target) === status) return;
  lastPollKey.set(target, status);
  recordMonitorRequest({ type: 'poll', target, status });
}

/** Newest first. */
export function getMonitorRequests(limit = 8): MonitorRequest[] {
  return entries.slice(-limit).reverse();
}

export function getMonitorVersion(): number {
  return version;
}

export function subscribeMonitor(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function resetMonitor(): void {
  entries = [];
  lastPollKey = new Map();
  nextId = 1;
  emit();
}

/** Tells subscribers that monitor settings (not data) changed. */
export function notifyMonitorChange(): void {
  emit();
}
