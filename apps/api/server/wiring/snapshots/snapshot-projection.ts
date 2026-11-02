// The staged snapshot projection store (plan §5.3): a wiring-module store that
// parses and applies pushes against an in-memory projection. Like the change
// stream, it lives in wiring with no manifest port; it is created per runtime
// wiring and rebuilt from pushes after a restart.
import {
  applySnapshotPush,
  parseSnapshotPush,
  type SnapshotProjection,
} from "@fleet/work-execution";

export class SnapshotProjectionStore {
  private projection: SnapshotProjection = {};

  apply(push: unknown): { outcome: "applied" | "refused" | "invalid"; reason?: string } {
    const parsed = parseSnapshotPush(push);
    if (!parsed.ok) {
      return { outcome: "invalid", reason: parsed.reason };
    }
    const { next, result } = applySnapshotPush(this.projection, parsed.push);
    this.projection = next;
    if (result.outcome === "refused") {
      return { outcome: "refused", reason: result.reason };
    }
    return { outcome: "applied" };
  }

  read(): SnapshotProjection {
    return this.projection;
  }
}
