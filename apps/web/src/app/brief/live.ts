/**
 * Server-side loader for the /brief work-order list. W6-w replaces the body of
 * `loadBriefData` with the API read once `GET /v1/work-orders` is served; until
 * then the page shows the not-configured state and never sample rows. This
 * loader must not import the test fixture and must not call `fetch`.
 */

import { types } from "node:util";
import type { WorkOrderBriefEntry } from "./brief-wire";
import { parseWorkOrderBriefListEnvelope, readEnvelopeCode, selectWorkOrderEntry } from "./map-brief";

export type BriefPageData =
  | { readonly view: "listed"; readonly entries: readonly WorkOrderBriefEntry[]; readonly selectedId: string | null }
  | { readonly view: "empty" }
  | { readonly view: "error"; readonly reason: string }
  | { readonly view: "not-configured"; readonly reason: string };

export async function loadBriefData(_selectedWorkOrderId?: string): Promise<BriefPageData> {
  return { view: "not-configured", reason: "GET /v1/work-orders is not served yet" };
}

export function briefDataFromEnvelope(envelope: unknown, selectedWorkOrderId?: string): BriefPageData {
  const parsed = parseWorkOrderBriefListEnvelope(envelope, types.isProxy);
  if (parsed !== null) {
    if (parsed.entries.length === 0) {
      return { view: "empty" };
    }
    const selected = selectWorkOrderEntry(parsed.entries, selectedWorkOrderId);
    return { view: "listed", entries: parsed.entries, selectedId: selected?.workOrder.id ?? null };
  }
  const code = readEnvelopeCode(envelope, types.isProxy);
  if (code !== null && code !== "OK") {
    return { view: "error", reason: "api boundary answered " + code + " for /v1/work-orders" };
  }
  return { view: "error", reason: "api boundary returned an unexpected work-orders shape" };
}
