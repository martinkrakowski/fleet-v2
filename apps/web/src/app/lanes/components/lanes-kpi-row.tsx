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
  scopeNote: string | null;
}

export function LanesKpiRow({
  queued,
  unknown,
  blocked,
  held,
  slots,
  host,
  port,
  queuedAll,
  scopeNote
}: LanesKpiRowProps) {
  const queuedText =
    queuedAll === 1 ? "queued intent" : "queued intents";
  const suffix = scopeNote !== null ? ` · ${scopeNote}` : "";
  return (
    <div className="row col-4">
      <StatCard
        tone="neutral"
        label="queued"
        value={queued}
        subtext={`intents recorded · no session yet · waiting for a slot${suffix}`}
      />
      <StatCard
        tone="warn"
        label="unknown"
        value={unknown}
        subtext={`runner could not be read · not idle, not a pass · holds its slot${suffix}`}
      />
      <StatCard
        tone="decision"
        label="blocked"
        value={blocked}
        subtext={`waiting on a signed decision in Waves · silence is not approval${suffix}`}
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
              {suffix}
            </>
          ) : (
            <>
              slot budget not served by the API · {queuedAll} {queuedText}{" "}
              behind them{suffix}
            </>
          )
        }
      />
    </div>
  );
}
