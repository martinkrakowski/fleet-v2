/**
 * The host descriptor reader behind `hosts add --from-descriptor` (plan
 * 2026-10-16_add-host.md, H13): an allow-listed set of fields — the port,
 * the worktree root, the runner tool and its claimed version, and the
 * capability declaration. Every other field is refused, and the capability
 * `source` is never read from a descriptor: the loader derives it. This
 * module is pure: no filesystem, no subprocess, no clock, no `any`, no
 * console logging — the CLI is the I/O boundary.
 */

import { isAbsolute } from 'node:path';

/** The only runner kind this lane drafts; anything else is refused. */
export type HostDescriptorToolName = 'opencode';

/** One tool entry: the runner kind and the version the descriptor claims. */
export interface HostDescriptorTool {
  readonly name: HostDescriptorToolName;
  readonly version: string;
}

/** The four declaration fields a descriptor may carry, exactly as v2 does. */
export interface HostDescriptorCapabilities {
  readonly networkEgressRestricted: boolean;
  readonly cpuAndMemoryLimited: boolean;
  readonly processTreeTermination: boolean;
  readonly filesystemScope: 'scoped-worktree' | 'inherited-directory';
}

/** A parsed host descriptor: everything the draft needs but the alias/roles. */
export interface HostDescriptor {
  readonly port: number;
  readonly worktreeRoot: string;
  readonly tools: readonly HostDescriptorTool[];
  readonly capabilities?: HostDescriptorCapabilities;
}

/** A parsed descriptor, or the reasons it is refused. */
export type HostDescriptorResult =
  | { readonly ok: true; readonly descriptor: HostDescriptor }
  | { readonly ok: false; readonly errors: readonly string[] };

const TOP_LEVEL_KEYS: readonly string[] = [
  'port',
  'worktreeRoot',
  'tools',
  'capabilities',
];

const TOOL_KEYS: readonly string[] = ['name', 'version'];

const CAPABILITY_KEYS: readonly string[] = [
  'networkEgressRestricted',
  'cpuAndMemoryLimited',
  'processTreeTermination',
  'filesystemScope',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/** The name a tool entry declares, or null when it names nothing usable. */
function toolNameOf(entry: unknown): string | null {
  if (!isRecord(entry)) {
    return null;
  }
  const name = entry.name;
  return typeof name === 'string' ? name : null;
}

/**
 * A repeated tool name hides a later entry's version from the single
 * comparison the CLI makes, so each repeat is refused at its own index.
 */
function duplicateToolNameError(tools: readonly unknown[], index: number): string | null {
  const name = toolNameOf(tools[index]);
  if (name === null) {
    return null;
  }
  for (let earlier = 0; earlier < index; earlier += 1) {
    if (toolNameOf(tools[earlier]) === name) {
      return `descriptor.tools[${index}].name: names the same tool twice`;
    }
  }
  return null;
}

export function parseHostDescriptor(value: unknown): HostDescriptorResult {
  if (!isRecord(value)) {
    return { ok: false, errors: ['descriptor: must be an object'] };
  }

  const errors: string[] = [];

  for (const key of Object.keys(value)) {
    if (!TOP_LEVEL_KEYS.includes(key)) {
      errors.push('descriptor: unknown key');
    }
  }

  const port = value.port;
  if (typeof port !== 'number' || !isValidPort(port)) {
    errors.push('descriptor.port: must be an integer 1..65535');
  }

  const worktreeRoot = value.worktreeRoot;
  if (typeof worktreeRoot !== 'string' || !isAbsolute(worktreeRoot)) {
    errors.push('descriptor.worktreeRoot: must be an absolute path');
  }

  const tools = value.tools;
  const distinctToolNames = new Set<string>();
  if (!Array.isArray(tools) || tools.length === 0) {
    errors.push('descriptor.tools: must be a non-empty array');
  } else {
    for (const [index, entry] of tools.entries()) {
      const path = `descriptor.tools[${index}]`;
      const duplicateNameError = duplicateToolNameError(tools, index);
      if (duplicateNameError !== null) {
        errors.push(duplicateNameError);
      }
      if (!isRecord(entry)) {
        errors.push(`${path}: must be an object`);
        continue;
      }
      for (const key of Object.keys(entry)) {
        if (!TOOL_KEYS.includes(key)) {
          errors.push(`${path}: unknown key`);
        }
      }
      const name = entry.name;
      if (typeof name === 'string') {
        distinctToolNames.add(name);
      }
      if (name === 'agy') {
        errors.push(
          `${path}.name: an agy runner declares its mode and the security acknowledgement, which no descriptor carries; add that host without --from-descriptor`,
        );
      } else if (name !== 'opencode') {
        errors.push(`${path}.name: must be a known runner kind (opencode)`);
      }
      const version = entry.version;
      if (typeof version !== 'string' || version.trim() === '') {
        errors.push(`${path}.version: must be a non-empty string`);
      }
    }
  }
  if (distinctToolNames.size > 1) {
    errors.push('descriptor.tools: names more than one tool');
  }

  const capabilitiesValue = value.capabilities;
  let parsedCapabilities: HostDescriptorCapabilities | undefined;
  if (capabilitiesValue !== undefined) {
    const capPath = 'descriptor.capabilities';
    if (!isRecord(capabilitiesValue)) {
      errors.push(`${capPath}: must be an object`);
    } else {
      for (const key of Object.keys(capabilitiesValue)) {
        if (key === 'source') {
          errors.push(
            `${capPath}.source: is derived by the loader and is never read from a descriptor`,
          );
        } else if (!CAPABILITY_KEYS.includes(key)) {
          errors.push(`${capPath}: unknown key`);
        }
      }
      for (const key of CAPABILITY_KEYS) {
        const fieldPath = `${capPath}.${key}`;
        const fieldValue = capabilitiesValue[key];
        if (fieldValue === undefined) {
          errors.push(`${fieldPath}: required`);
        } else if (key === 'filesystemScope') {
          if (
            fieldValue !== 'scoped-worktree' &&
            fieldValue !== 'inherited-directory'
          ) {
            errors.push(`${fieldPath}: must be a known filesystem scope`);
          }
        } else if (typeof fieldValue !== 'boolean') {
          errors.push(`${fieldPath}: must be a boolean`);
        }
      }
      parsedCapabilities = {
        networkEgressRestricted:
          capabilitiesValue.networkEgressRestricted as boolean,
        cpuAndMemoryLimited: capabilitiesValue.cpuAndMemoryLimited as boolean,
        processTreeTermination:
          capabilitiesValue.processTreeTermination as boolean,
        filesystemScope: capabilitiesValue.filesystemScope as
          | 'scoped-worktree'
          | 'inherited-directory',
      };
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    descriptor: {
      port: port as number,
      worktreeRoot: worktreeRoot as string,
      tools: (tools as Record<string, unknown>[]).map((entry) => ({
        name: 'opencode',
        version: entry.version as string,
      })),
      ...(parsedCapabilities !== undefined
        ? { capabilities: parsedCapabilities }
        : {}),
    },
  };
}
