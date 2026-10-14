import { StatCard } from "@fleet/ui";

export interface LanesKpiRowProps {
  queued: number;
  unknown: number;
  blocked: number;
  held: number;
  slots: number;
  host: string;
  port: number;
  queuedAll: number;
}

export function LanesKpiRow({
  queued,
  unknown,
  blocked,
  held,
  slots,
  host,
  port,
  queuedAll
}: LanesKpiRowProps) {
  return (
    <div className="row col-4">
      <StatCard
        tone="neutral"
        label="queued"
        value={queued}
        subtext="intents recorded · no session yet · waiting for a slot"
      />
      <StatCard
        tone="warn"
        label="unknown"
        value={unknown}
        subtext="runner could not be read · not idle, not a pass · holds its slot"
      />
      <StatCard
        tone="decision"
        label="blocked"
        value={blocked}
        subtext="waiting on a signed decision in Waves · silence is not approval"
      />
      <StatCard
        tone="accent"
        label="slots held"
        value={
          <>
            {held}
            <small>/{slots}</small>
          </>
        }
        subtext={
          <>
            {host} · port {port} · {queuedAll} queued intent
            {queuedAll === 1 ? "" : "s"} behind them
          </>
        }
      />
    </div>
  );
}