"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import type { LanesData } from "./live";

/**
 * The Lanes page re-fetches only the live API source, and only while the tab
 * is visible. The fixture fallback is fixed sample data and never refreshes.
 */
export function shouldRefresh(
  source: LanesData["source"],
  visibility: string,
): boolean {
  return source === "api" && visibility === "visible";
}

/**
 * Re-fetches the page from the server every `intervalMs` while the source is
 * the live API and the document is visible. Cleared on unmount.
 */
export function useAutoRefresh(
  source: LanesData["source"],
  intervalMs = 30_000,
): void {
  const router = useRouter();
  useEffect(() => {
    const id = window.setInterval(() => {
      if (shouldRefresh(source, document.visibilityState)) {
        router.refresh();
      }
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [source, intervalMs, router]);
}
