/**
 * Recorded usage view helpers shared by the lanes rows and the work-order
 * timeline. Pure: imports only types, so it is safe on both the client and
 * the server side. Billing follows the recorded runner kind — opencode
 * figures are as opencode recorded them, agy figures are plan-billed
 * estimates (not spend), and any other recorded kind means billing is not
 * recorded.
 */

import type { RecordedRunner, RecordedUsage } from "./attempt-wire";

export type Billing = "metered" | "plan" | "unknown";

export interface UsageInput {
  readonly runner: RecordedRunner | null;
  readonly usage: RecordedUsage | null;
}

const PLAN_BILLED_NOTE = "plan, not spend";

export function billingOf(runner: RecordedRunner | null): Billing {
  switch (runner?.kind) {
    case "opencode":
      return "metered";
    case "agy":
      return "plan";
    default:
      return "unknown";
  }
}

export function seatChipText(runner: RecordedRunner | null): string {
  if (runner === null) {
    return "seat not recorded";
  }
  const parts = [runner.kind];
  if (runner.agent !== null) {
    parts.push(runner.agent);
  }
  if (runner.variant !== null) {
    parts.push(runner.variant);
  }
  return parts.join(" · ");
}

export function modelChipText(input: UsageInput): string {
  if (input.runner !== null && input.runner.model !== null) {
    return input.runner.model;
  }
  if (input.usage !== null && input.usage.model !== null) {
    return input.usage.model;
  }
  return "model not recorded";
}

export interface UsageChip {
  readonly text: string;
  readonly title: string;
  readonly estimate: boolean;
}

export function usageChip(input: UsageInput): UsageChip {
  const usage = input.usage;
  if (usage === null) {
    return {
      text: "not measured",
      title: "usage source: not recorded",
      estimate: false,
    };
  }
  if (usage.source === "unavailable") {
    return {
      text: "not measured",
      title: "usage source: unavailable",
      estimate: false,
    };
  }
  const sourceTitle = `usage source: ${usage.source}`;
  if (usage.costUsd === null) {
    return {
      text: "cost unreadable (not 0)",
      title: sourceTitle,
      estimate: false,
    };
  }
  switch (billingOf(input.runner)) {
    case "plan":
      return {
        text: `est. ${money(usage.costUsd)} · plan`,
        title: `${sourceTitle} · plan-billed seat: an estimate, not spend`,
        estimate: true,
      };
    case "metered":
      return { text: money(usage.costUsd), title: sourceTitle, estimate: false };
    default:
      return {
        text: `${money(usage.costUsd)} · billing not recorded`,
        title: sourceTitle,
        estimate: false,
      };
  }
}

export interface UsageSum {
  readonly attempts: number;
  readonly measured: number;
  readonly notMeasured: number;
  readonly meteredUsd: number;
  readonly estimateUsd: number;
  readonly unknownBillingUsd: number;
}

export function sumUsage(items: readonly UsageInput[]): UsageSum {
  let attempts = 0;
  let measured = 0;
  let notMeasured = 0;
  let meteredUsd = 0;
  let estimateUsd = 0;
  let unknownBillingUsd = 0;
  for (const item of items) {
    attempts += 1;
    const usage = item.usage;
    if (
      usage === null ||
      usage.source !== "opencode-db" ||
      usage.costUsd === null
    ) {
      notMeasured += 1;
      continue;
    }
    measured += 1;
    switch (billingOf(item.runner)) {
      case "metered":
        meteredUsd += usage.costUsd;
        break;
      case "plan":
        estimateUsd += usage.costUsd;
        break;
      default:
        unknownBillingUsd += usage.costUsd;
        break;
    }
  }
  return {
    attempts,
    measured,
    notMeasured,
    meteredUsd,
    estimateUsd,
    unknownBillingUsd,
  };
}

export function usageSumText(sum: UsageSum): string {
  if (sum.attempts === 0) {
    return "no attempts recorded";
  }
  if (sum.measured === 0) {
    return `not measured on any of ${sum.attempts} ${
      sum.attempts === 1 ? "attempt" : "attempts"
    }`;
  }
  const parts: string[] = [];
  if (sum.meteredUsd > 0) {
    parts.push(`${money(sum.meteredUsd)} metered`);
  }
  if (sum.estimateUsd > 0) {
    parts.push(`est. ${money(sum.estimateUsd)} ${PLAN_BILLED_NOTE}`);
  }
  if (sum.unknownBillingUsd > 0) {
    parts.push(`${money(sum.unknownBillingUsd)} billing not recorded`);
  }
  parts.push(`over ${sum.measured} of ${sum.attempts} attempts`);
  if (sum.notMeasured > 0) {
    parts.push(`${sum.notMeasured} not measured`);
  }
  return parts.join(" · ");
}

export function money(usd: number): string {
  return `$${usd.toFixed(2)}`;
}
