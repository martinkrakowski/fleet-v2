import { randomBytes } from "node:crypto";

import {
  PullRequestFindingsReadAdapter,
  type ExecuteAuthorizedForgeActionPort,
  type ForgeActionAdapter,
  type ForgeActionDelegate,
  type PrepareFixAttemptResult,
} from "@fleet/work-execution";
import { PreparePullRequestFeedbackFixUseCase } from "@fleet/work-execution/use-cases";

/** One repository owner/repo pair. */
export interface BoundForgeRepository {
  readonly owner: string;
  readonly repo: string;
}

const REPOSITORY_SEGMENT = /^[A-Za-z0-9_.-]+$/;

/** One own data property, read without running a getter; undefined for anything else. */
function ownData(source: unknown, key: string): unknown {
  try {
    if (typeof source !== "object" || source === null) {
      return undefined;
    }
    return Object.getOwnPropertyDescriptor(source, key)?.value;
  } catch {
    return undefined;
  }
}

/** A fresh `{ owner, repo }` copy of a well-formed repository reference, or undefined. */
function readRepository(value: unknown): BoundForgeRepository | undefined {
  const owner = ownData(value, "owner");
  const repo = ownData(value, "repo");
  if (
    typeof owner !== "string" ||
    typeof repo !== "string" ||
    !REPOSITORY_SEGMENT.test(owner) ||
    !REPOSITORY_SEGMENT.test(repo)
  ) {
    return undefined;
  }
  return { owner, repo };
}

function sameRepository(left: BoundForgeRepository, right: BoundForgeRepository): boolean {
  return (
    left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.repo.toLowerCase() === right.repo.toLowerCase()
  );
}

/**
 * The one repository the PR-feedback fix round may act on, or undefined when
 * there is none (every request then refuses `repository-mismatch`).
 */
export function resolveBoundForgeRepository(input: {
  readonly forgeRepository: unknown;
  readonly forgeConfigured: boolean;
  readonly installationRepository: BoundForgeRepository | undefined;
}): BoundForgeRepository | undefined {
  if (input.forgeRepository === undefined) {
    return input.forgeConfigured ? undefined : input.installationRepository;
  }
  const bound = readRepository(input.forgeRepository);
  if (bound === undefined) {
    return undefined;
  }
  if (input.installationRepository !== undefined && !sameRepository(bound, input.installationRepository)) {
    return undefined;
  }
  return bound;
}

export interface PullRequestFeedbackFixWiring {
  readonly forgePort: Pick<ForgeActionAdapter, "boundRepository" | "isConfigured">;
  readonly runGh: ForgeActionDelegate["runGh"];
  readonly forgeMode: "github" | "none" | undefined;
  readonly installationRepository: BoundForgeRepository | undefined;
  readonly prepareFixAttempt: { execute(input?: unknown): Promise<PrepareFixAttemptResult> };
  readonly executeForgeAction: ExecuteAuthorizedForgeActionPort;
}

export function composePullRequestFeedbackFix(
  input: PullRequestFeedbackFixWiring,
): PreparePullRequestFeedbackFixUseCase {
  const bound = resolveBoundForgeRepository({
    forgeRepository: input.forgePort.boundRepository(),
    forgeConfigured: input.forgePort.isConfigured(),
    installationRepository: input.installationRepository,
  });
  const runGh = input.runGh;
  const findings =
    bound !== undefined && input.forgeMode !== "none" && typeof runGh === "function"
      ? new PullRequestFindingsReadAdapter({
          repository: bound,
          runGh: (args, timeoutMs) => runGh(args, undefined, timeoutMs),
        })
      : new PullRequestFindingsReadAdapter();
  return new PreparePullRequestFeedbackFixUseCase({
    findings,
    prepareFixAttempt: {
      prepareFixAttempt: (request) => input.prepareFixAttempt.execute(request),
    },
    executeForgeAction: input.executeForgeAction,
    repository: bound ?? { owner: "", repo: "" },
    nowIso: () => new Date().toISOString(),
    mintNonce: () => randomBytes(16).toString("hex"),
  });
}
