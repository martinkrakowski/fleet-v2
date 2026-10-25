/**
 * ListUnregisteredProjectsUseCase: list projects that have work orders but no
 * profile, with what their work orders say, so a later adoption lane can
 * pre-fill a registration. Read-only: never saves, never writes.
 */

import type { WorkOrderRecord } from '../../domain/execution-records.js';
import type {
  ListUnregisteredProjectsPort,
  ListUnregisteredProjectsResult,
  UnregisteredProject,
} from '../ports/in/ListUnregisteredProjectsPort.in-port.js';
import type { WorkOrderRepositoryPort } from '../ports/out/WorkOrderRepositoryPort.out-port.js';
import type { ProjectProfileReadPort } from '../ports/out/ProjectProfileReadPort.out-port.js';

export interface ListUnregisteredProjectsDependencies {
  readonly workOrderRepo: WorkOrderRepositoryPort;
  readonly profileRead: ProjectProfileReadPort;
}

/** Terminal work orders no longer claim their paths against new lanes. */
function isActiveWorkOrder(state: WorkOrderRecord['state']): boolean {
  return state !== 'merged' && state !== 'stopped';
}

/** Code-unit order, the same order a bare `sort()` gives strings. */
function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function distinctSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

function buildProject(
  projectId: string,
  orders: readonly WorkOrderRecord[],
): UnregisteredProject {
  const activeWorkOrderCount = orders.reduce(
    (count, order) => count + (isActiveWorkOrder(order.state) ? 1 : 0),
    0,
  );

  const repositories = distinctSorted(
    orders
      .map((order) => order.repository.trim())
      .filter((repository) => repository.length > 0),
  );

  let latestBaseCommit: string | null = null;
  let newestUpdatedAtIso = '';
  let newestId = '';
  for (const order of orders) {
    const isNewer =
      order.updatedAtIso > newestUpdatedAtIso ||
      (order.updatedAtIso === newestUpdatedAtIso && order.id > newestId);
    if (isNewer) {
      latestBaseCommit = order.baseCommit;
      newestUpdatedAtIso = order.updatedAtIso;
      newestId = order.id;
    }
  }

  const ownedPaths = distinctSorted(orders.flatMap((order) => order.ownedPaths)).slice(0, 50);

  const lastUpdatedAtIso = orders.reduce(
    (max, order) => (order.updatedAtIso > max ? order.updatedAtIso : max),
    '',
  );

  return {
    projectId,
    workOrderCount: orders.length,
    activeWorkOrderCount,
    repositories,
    latestBaseCommit,
    ownedPaths,
    lastUpdatedAtIso,
  };
}

export class ListUnregisteredProjectsUseCase implements ListUnregisteredProjectsPort {
  constructor(private readonly deps?: ListUnregisteredProjectsDependencies) {}

  async execute(input?: unknown): Promise<ListUnregisteredProjectsResult> {
    if (!this.deps) {
      throw new Error('Not implemented: ListUnregisteredProjectsUseCase');
    }

    // The request has no fields, so an omitted argument is an empty request.
    const request: unknown = input === undefined ? {} : input;
    const isPlainObject =
      typeof request === 'object' &&
      request !== null &&
      (Object.getPrototypeOf(request) === Object.prototype ||
        Object.getPrototypeOf(request) === null);
    if (!isPlainObject) {
      throw new Error('request must be an object');
    }

    const { workOrderRepo, profileRead } = this.deps;

    const workOrders = await workOrderRepo.listWorkOrdersByProject();

    const groups = new Map<string, WorkOrderRecord[]>();
    for (const order of workOrders) {
      const projectId = order.projectId.trim();
      if (projectId.length === 0) {
        continue;
      }
      const group = groups.get(projectId);
      if (group === undefined) {
        groups.set(projectId, [order]);
      } else {
        group.push(order);
      }
    }

    const projects: UnregisteredProject[] = [];
    for (const [projectId, orders] of groups) {
      const profile = await profileRead.readProjectProfile(projectId);
      if (profile !== null) {
        continue;
      }
      projects.push(buildProject(projectId, orders));
    }

    projects.sort((a, b) => compareCodeUnits(a.projectId, b.projectId));

    return { outcome: 'listed', projects };
  }
}
