"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  parseChangeSignal,
  type ChangeSignal,
} from "../../lib/live/changes-relay";

export const CHANGE_SIGNAL_PATH = "/live/changes";
export const CHANGE_SIGNAL_DEBOUNCE_MS = 250;
export const CHANGE_SIGNAL_RETRY_MS = 5_000;

/** null for an unparseable payload. */
export function parseSignalData(text: string): ChangeSignal | null {
  if (typeof text !== "string") {
    return null;
  }
  return parseChangeSignal(text);
}

/** 0 for a resync (one full refresh now), the debounce otherwise. */
export function refreshDelayMs(kind: string): number {
  return kind === "resync" ? 0 : CHANGE_SIGNAL_DEBOUNCE_MS;
}

/**
 * Subscribes to the same-origin `/live/changes` SSE relay while the tab is
 * visible; the 30 s poll stays as the fallback. Every parsed signal schedules
 * one debounced `router.refresh()` (a `resync` refreshes immediately); a burst
 * of signals causes one refresh, not one per signal.
 */
export function useChangeSignals(): void {
  const router = useRouter();
  useEffect(() => {
    if (typeof EventSource === "undefined") {
      return;
    }

    let source: EventSource | null = null;
    let refreshTimer: number | null = null;
    let retryTimer: number | null = null;

    const scheduleRefresh = (delay: number) => {
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer);
      }
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        router.refresh();
      }, delay);
    };

    const closeSource = () => {
      if (source !== null) {
        source.close();
        source = null;
      }
    };

    const subscribe = () => {
      if (source !== null || document.visibilityState !== "visible") {
        return;
      }
      const next = new EventSource(CHANGE_SIGNAL_PATH);
      next.onmessage = (event: MessageEvent<string>) => {
        const signal = parseSignalData(event.data);
        if (signal !== null) {
          scheduleRefresh(refreshDelayMs(signal.kind));
        }
      };
      next.onerror = () => {
        closeSource();
        if (document.visibilityState === "visible" && retryTimer === null) {
          retryTimer = window.setTimeout(() => {
            retryTimer = null;
            subscribe();
          }, CHANGE_SIGNAL_RETRY_MS);
        }
      };
      source = next;
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        subscribe();
      } else {
        closeSource();
      }
    };

    subscribe();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer);
      }
      closeSource();
    };
  }, [router]);
}
