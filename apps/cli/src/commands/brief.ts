/** The `brief` command group of the CLI driver; its entries moved verbatim from the command table. */

import { parseSeatTool, unhealthySeatIdsFromCatalog } from '@fleet/work-execution';
import type { AuthorBriefRequest, BuildFactPackFact, AcceptanceSpecProps, BriefContextDecision, BriefModelAssignment } from '@fleet/work-execution';
import { FACT_PACK_MAX_FACTS } from '@fleet/work-execution';
import { str, optStr, strOrNull, num, strArr, nested, nestedArr, jsonStrArr, jsonObj, derivedV2Model, briefSeatPlan, safeJsonParse, CliUsageError } from './payload.js';
import type { CommandHandler, Payload } from './payload.js';

export const briefCommands: Readonly<Record<string, CommandHandler>> = {
    prepare: async (p, rt) => {
      const contextDecisions = nestedArr<BriefContextDecision>(p, 'contextDecisions') ?? [];
      for (const decision of contextDecisions) {
        if (
          !decision ||
          typeof decision !== 'object' ||
          typeof decision.decisionBecause !== 'string' ||
          decision.decisionBecause.trim() === ''
        ) {
          throw new CliUsageError(
            "brief prepare contextDecisions requires a non-empty 'decisionBecause' for each item",
          );
        }
      }
      // H8: the seat tool is required and frozen into the manifest, so it is
      // covered by the digest. Missing or undeclared is a usage error (exit
      // 2), never a default to opencode.
      const nestedAssignment = nested<BriefModelAssignment>(p, 'modelAssignment');
      const rawSeatTool = p['seatTool'] ?? nestedAssignment?.seatTool;
      const seatTool = parseSeatTool(rawSeatTool);
      if (seatTool === undefined) {
        throw new CliUsageError(
          'brief prepare requires --seatTool naming a declared runner kind (opencode or agy)',
        );
      }
      if (
        nestedAssignment !== undefined &&
        nestedAssignment.seatTool !== undefined &&
        nestedAssignment.seatTool !== seatTool
      ) {
        throw new CliUsageError(
          `'--seatTool ${String(seatTool)}' conflicts with the seat tool in --modelAssignment`,
        );
      }
      const seatPlan = briefSeatPlan(p, rt);
      const unhealthy = new Set(unhealthySeatIdsFromCatalog(derivedV2Model(rt)));
      const planSeatForAssignment =
        seatPlan !== undefined && nestedAssignment === undefined && optStr(p, 'model') === undefined
          ? seatPlan['first-pass'].find((seat) => !unhealthy.has(seat.id))
          : undefined;
      if (
        seatPlan !== undefined &&
        nestedAssignment === undefined &&
        optStr(p, 'model') === undefined &&
        planSeatForAssignment === undefined
      ) {
        throw new CliUsageError(
          'Every first-pass seat of the seat plan is unhealthy; pass --model to choose one',
        );
      }
      let modelAssignment: BriefModelAssignment;
      if (nestedAssignment !== undefined) {
        modelAssignment = { ...nestedAssignment, seatTool };
      } else if (planSeatForAssignment !== undefined) {
        modelAssignment = {
          model: planSeatForAssignment.model,
          variant: planSeatForAssignment.variant ?? 'default',
          fallbackModel: str(p, 'fallbackModel') || planSeatForAssignment.model,
          seatTool,
          ...(planSeatForAssignment.agent !== undefined ? { agent: planSeatForAssignment.agent } : {}),
        } as BriefModelAssignment;
      } else {
        modelAssignment = {
          model: str(p, 'model'),
          variant: str(p, 'variant') || 'default',
          fallbackModel: str(p, 'fallbackModel'),
          seatTool,
        };
      }
      return rt.execution.prepareBriefPackage.prepareBriefPackage({
        workOrderId: str(p, 'workOrderId'),
        projectId: str(p, 'projectId'),
        taskId: str(p, 'taskId'),
        laneId: str(p, 'laneId'),
        repository: str(p, 'repository'),
        baseCommit: str(p, 'baseCommit'),
        policyRevision: str(p, 'policyRevision'),
        modelAssignment,
        independentReviewer: str(p, 'independentReviewer'),
        ownedPaths: strArr(p, 'ownedPaths'),
        // The edit-only diff check's allowed prefixes: one JSON array (or an
        // array in --json). A malformed value is a usage error (exit 2),
        // never a silent empty list.
        allowedPathPrefixes: jsonStrArr(p, 'allowedPathPrefixes', 'brief prepare'),
        permissions: strArr(p, 'permissions'),
        acceptanceChecks: strArr(p, 'acceptanceChecks'),
        acceptanceSpec: jsonObj(p, 'acceptanceSpec', 'brief prepare') as AcceptanceSpecProps | undefined,
        stepLimit: num(p, 'stepLimit', 200),
        timeLimitSeconds: num(p, 'timeLimitSeconds', 3600),
        resourceBounds: nested<Record<string, string>>(p, 'resourceBounds') ?? {},
        expectedArtifacts: strArr(p, 'expectedArtifacts'),
        ownerDecisionReferences: strArr(p, 'ownerDecisionReferences'),
        contextDecisions,
        attemptId: optStr(p, 'attemptId'),
        worktreePath: optStr(p, 'worktreePath'),
        handWrittenBriefPath: strOrNull(p, 'handWrittenBriefPath'),
        ...(seatPlan !== undefined ? { seatPlan } : {}),
      });
    },

    // CO17c: `brief author` builds one request, calls the use case once, and
    // returns its result unchanged. The seat's answer is the only prose: the
    // handler validates the invocation shape (exit 2 on a malformed one),
    // never dispatches, writes nothing and prints nothing itself.
    author: async (p, rt) => {
      /** Read one payload field exactly once; a throwing getter is a usage error. */
      const field = (key: string): unknown => {
        try {
          return p[key];
        } catch {
          throw new CliUsageError('brief author could not read its arguments');
        }
      };
      /** Read one field through the shared coercion helper, still exactly once. */
      const viaHelper = <T>(key: string, read: (payload: Payload) => T): T => read({ [key]: field(key) });
      /** An optional non-empty string read exactly once. */
      const opt = (key: string): string | undefined => viaHelper(key, (payload) => optStr(payload, key));

      const required = (key: string): string => {
        const value = viaHelper(key, (payload) => str(payload, key)).trim();
        if (value === '') {
          throw new CliUsageError(`brief author requires --${key}`);
        }
        return value;
      };

      const workOrderId = required('workOrderId');
      const laneId = required('laneId');
      const projectId = required('projectId');
      const taskId = required('taskId');
      const repository = required('repository');
      const baseCommit = required('baseCommit');
      const policyRevision = required('policyRevision');
      const implementerModel = required('model');
      const fallbackModel = required('fallbackModel');
      const independentReviewer = required('independentReviewer');
      const authorModel = required('authorModel');
      const checkoutPath = required('checkoutPath');
      const repositoryPath = required('repositoryPath');

      if (!/^[0-9a-f]{40,64}$/.test(baseCommit)) {
        throw new CliUsageError('brief author requires --baseCommit as 40 to 64 lowercase hex characters');
      }

      const worktreePath = required('worktreePath');
      if (!worktreePath.startsWith('/') || worktreePath === '/') {
        throw new CliUsageError('brief author requires an absolute --worktreePath that is not the filesystem root');
      }

      const briefsDir = required('briefsDir');
      if (!briefsDir.startsWith('/') || briefsDir.split('/').includes('..')) {
        throw new CliUsageError("brief author requires an absolute --briefsDir with no '..' segment");
      }

      // The seat answer is the only prose: operator-supplied prose or a
      // hand-written path is refused before the use case is called.
      if (opt('proseMarkdown') !== undefined) {
        throw new CliUsageError('brief author takes the brief from the seat; --proseMarkdown is not accepted');
      }
      if (opt('handWrittenBriefPath') !== undefined) {
        throw new CliUsageError('brief author takes the brief from the seat; --handWrittenBriefPath is not accepted');
      }

      // Facts: exactly one JSON array, at most FACT_PACK_MAX_FACTS entries,
      // each copied into a fresh allowlisted object; the length is read once
      // and a longer array is refused before any element is read.
      const rawFacts = field('facts');
      let factsList: readonly unknown[];
      if (rawFacts === undefined) {
        throw new CliUsageError("brief author requires a JSON array of fact objects in '--facts'");
      }
      if (typeof rawFacts === 'string') {
        const parsed = safeJsonParse(rawFacts);
        if (!Array.isArray(parsed)) {
          throw new CliUsageError("brief author requires a JSON array of fact objects in '--facts'");
        }
        factsList = parsed;
      } else if (Array.isArray(rawFacts)) {
        factsList = rawFacts;
      } else {
        throw new CliUsageError("brief author requires a JSON array of fact objects in '--facts'");
      }
      const factCount = factsList.length;
      if (factCount > FACT_PACK_MAX_FACTS) {
        throw new CliUsageError('brief author accepts at most 32 facts');
      }
      const copiedFacts: BuildFactPackFact[] = [];
      for (let index = 0; index < factCount; index += 1) {
        const fact: unknown = factsList[index];
        if (!(index in factsList) || typeof fact !== 'object' || fact === null || Array.isArray(fact)) {
          throw new CliUsageError(`brief author fact ${index} is missing`);
        }
        const record = fact as Record<string, unknown>;
        const kind = record['kind'];
        const label = record['label'];
        if (typeof kind !== 'string' || typeof label !== 'string' || label === '') {
          throw new CliUsageError(`brief author fact ${index} is malformed`);
        }
        const stringField = (key: string): string => {
          const value = record[key];
          if (typeof value !== 'string') {
            throw new CliUsageError(`brief author fact ${index} is malformed`);
          }
          return value;
        };
        const numberField = (key: string): number => {
          const value = record[key];
          if (typeof value !== 'number') {
            throw new CliUsageError(`brief author fact ${index} is malformed`);
          }
          return value;
        };
        // The allowlist copy drops `__proto__`, `constructor` and every other key.
        if (kind === 'file-list') {
          copiedFacts.push({ kind, label, pathPrefix: stringField('pathPrefix') });
        } else if (kind === 'file-range') {
          copiedFacts.push({
            kind, label, path: stringField('path'), fromLine: numberField('fromLine'), toLine: numberField('toLine'),
          });
        } else if (kind === 'matching-lines') {
          copiedFacts.push({ kind, label, path: stringField('path'), token: stringField('token') });
        } else {
          throw new CliUsageError(`brief author fact ${index} is malformed`);
        }
      }

      // The seat tool and the model assignment, as `brief prepare` freezes them.
      const contextDecisions = viaHelper('contextDecisions', (payload) => nestedArr<BriefContextDecision>(payload, 'contextDecisions')) ?? [];
      for (const decision of contextDecisions) {
        if (
          !decision ||
          typeof decision !== 'object' ||
          typeof decision.decisionBecause !== 'string' ||
          decision.decisionBecause.trim() === ''
        ) {
          throw new CliUsageError(
            "brief author contextDecisions requires a non-empty 'decisionBecause' for each item",
          );
        }
      }
      const nestedAssignment = viaHelper('modelAssignment', (payload) => nested<BriefModelAssignment>(payload, 'modelAssignment'));
      const rawSeatTool = field('seatTool') ?? nestedAssignment?.seatTool;
      const seatTool = parseSeatTool(rawSeatTool);
      if (seatTool === undefined) {
        throw new CliUsageError(
          'brief author requires --seatTool naming a declared runner kind (opencode or agy)',
        );
      }
      if (
        nestedAssignment !== undefined &&
        nestedAssignment.seatTool !== undefined &&
        nestedAssignment.seatTool !== seatTool
      ) {
        throw new CliUsageError(
          `'--seatTool ${String(seatTool)}' conflicts with the seat tool in --modelAssignment`,
        );
      }
      const seatPlan = briefSeatPlan(p, rt);
      const unhealthy = new Set(unhealthySeatIdsFromCatalog(derivedV2Model(rt)));
      const planSeatForAssignment =
        seatPlan !== undefined && nestedAssignment === undefined && opt('model') === undefined
          ? seatPlan['first-pass'].find((seat) => !unhealthy.has(seat.id))
          : undefined;
      if (
        seatPlan !== undefined &&
        nestedAssignment === undefined &&
        opt('model') === undefined &&
        planSeatForAssignment === undefined
      ) {
        throw new CliUsageError(
          'Every first-pass seat of the seat plan is unhealthy; pass --model to choose one',
        );
      }
      let modelAssignment: BriefModelAssignment;
      if (nestedAssignment !== undefined) {
        modelAssignment = { ...nestedAssignment, seatTool };
      } else if (planSeatForAssignment !== undefined) {
        modelAssignment = {
          model: planSeatForAssignment.model,
          variant: planSeatForAssignment.variant ?? 'default',
          fallbackModel: fallbackModel || planSeatForAssignment.model,
          seatTool,
          ...(planSeatForAssignment.agent !== undefined ? { agent: planSeatForAssignment.agent } : {}),
        } as BriefModelAssignment;
      } else {
        modelAssignment = {
          model: implementerModel,
          variant: viaHelper('variant', (payload) => str(payload, 'variant')) || 'default',
          fallbackModel,
          seatTool,
        };
      }

      const allowedPathPrefixes = viaHelper('allowedPathPrefixes', (payload) => jsonStrArr(payload, 'allowedPathPrefixes', 'brief author'));
      const acceptanceSpec = viaHelper('acceptanceSpec', (payload) => jsonObj(payload, 'acceptanceSpec', 'brief author'));
      const prepare = {
        workOrderId,
        projectId,
        taskId,
        laneId,
        repository,
        baseCommit,
        policyRevision,
        modelAssignment,
        independentReviewer,
        ownedPaths: viaHelper('ownedPaths', (payload) => strArr(payload, 'ownedPaths')),
        allowedPathPrefixes,
        permissions: viaHelper('permissions', (payload) => strArr(payload, 'permissions')),
        acceptanceChecks: viaHelper('acceptanceChecks', (payload) => strArr(payload, 'acceptanceChecks')),
        acceptanceSpec,
        stepLimit: viaHelper('stepLimit', (payload) => num(payload, 'stepLimit', 200)),
        timeLimitSeconds: viaHelper('timeLimitSeconds', (payload) => num(payload, 'timeLimitSeconds', 3600)),
        resourceBounds: viaHelper('resourceBounds', (payload) => nested<Record<string, string>>(payload, 'resourceBounds')) ?? {},
        expectedArtifacts: viaHelper('expectedArtifacts', (payload) => strArr(payload, 'expectedArtifacts')),
        ownerDecisionReferences: viaHelper('ownerDecisionReferences', (payload) => strArr(payload, 'ownerDecisionReferences')),
        contextDecisions,
        attemptId: opt('attemptId'),
        worktreePath,
        ...(seatPlan !== undefined ? { seatPlan } : {}),
      };

      const authorVariant = opt('authorVariant');
      const authorAgent = opt('authorAgent');
      return rt.execution.authorBrief.authorBrief({
        workOrderId,
        laneId,
        prepare: prepare as AuthorBriefRequest['prepare'],
        factPack: { repositoryPath, commit: baseCommit, facts: copiedFacts },
        seat: {
          model: authorModel,
          ...(authorVariant !== undefined ? { variant: authorVariant } : {}),
          ...(authorAgent !== undefined ? { agent: authorAgent } : {}),
        },
        checkoutPath,
        briefsDir,
      });
    },
};
