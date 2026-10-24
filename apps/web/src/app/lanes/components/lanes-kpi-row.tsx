import { StatCard } from "@fleet/ui";

export interface LanesKpiRowProps {
  queued: number;
  unknown: number;
  blocked: number;
  held: number;
  slots: number | null;
  host: string | null;
  port: number | null;
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
  const queuedText =
    queuedAll === 1 ? "queued intent" : "queued intents";
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
          slots !== null ? (
            <>
              {held}
              <small>/{slots}</small>
            </>
          ) : (
            held
          )
        }
        subtext={
          slots !== null ? (
            <>
              {host} · port {port} · {queuedAll} {queuedText} behind them
            </>
          ) : (
            <>
              slot budget not served by the API · {queuedAll} {queuedText}{" "}
              behind them
            </>
          )
        }
      />
    </div>
  );
}
