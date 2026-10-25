"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import type { LanesData } from "./live";

export const NOT_CONFIGURED_REASON = "api boundary is not configured";

/**
 * The Lanes page re-fetches while the tab is visible when the source is the
 * live API or the page fell back to the fixture because a configured API
 * failed. Only an unconfigured API never refreshes.
 */
export function shouldRefresh(
  source: LanesData["source"],
  fallbackReason: string | null,
  visibility: string,
): boolean {
  return (
    visibility === "visible" &&
    (source === "api" || fallbackReason !== NOT_CONFIGURED_REASON)
  );
}

/**
 * Re-fetches the page from the server every `intervalMs` while the source is
 * the live API or a failed configured API and the document is visible. Cleared
 * on unmount.
 */
export function useAutoRefresh(
  source: LanesData["source"],
  fallbackReason: string | null,
  intervalMs = 30_000,
): void {
  const router = useRouter();
  useEffect(() => {
    const id = window.setInterval(() => {
      if (shouldRefresh(source, fallbackReason, document.visibilityState)) {
        router.refresh();
      }
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [source, fallbackReason, intervalMs, router]);
}
