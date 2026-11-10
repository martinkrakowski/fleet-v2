/**
 * The `owner-items` command group of the CLI driver: `add`, `list` and
 * `resolve` wire the existing OwnerItem use cases (WB7a subset). An owner item
 * grants nothing. The actor is always the literal `cli`, never a flag and
 * never the body.
 */

import {
  OWNER_ITEM_KINDS,
  OWNER_ITEM_REF_KINDS,
  OWNER_ITEM_RESOLUTION_KINDS,
  OWNER_ITEM_STATES,
  type OwnerItemRefRecord,
} from '@fleet/operator-coordination';
import { str, enumOf, firstPositional, CliUsageError } from './payload.js';
import type { CommandHandler, Payload } from './payload.js';

/** Parse one `--ref` token into a typed ref record; a malformed token is usage. */
function typedRef(token: string): OwnerItemRefRecord {
  // Longest kind prefix first so `plan-decision` is never read as `plan`.
  const kindsOrdered = [...OWNER_ITEM_REF_KINDS].sort((a, b) => b.length - a.length);
  for (const kind of kindsOrdered) {
    const prefix = `${kind}:`;
    if (!token.startsWith(prefix)) {
      continue;
    }
    const rest = token.slice(prefix.length);
    if (kind === 'question' || kind === 'work-order' || kind === 'run') {
      if (rest === '' || rest.includes(':')) {
        throw new CliUsageError(`invalid --ref ${token}`);
      }
      return { kind, id: rest };
    }
    if (kind === 'lane' || kind === 'plan-decision') {
      const separator = rest.indexOf(':');
      if (separator <= 0 || separator === rest.length - 1) {
        throw new CliUsageError(`invalid --ref ${token}`);
      }
      const planId = rest.slice(0, separator);
      const second = rest.slice(separator + 1);
      if (second === '' || second.includes(':')) {
        throw new CliUsageError(`invalid --ref ${token}`);
      }
      return kind === 'lane'
        ? { kind: 'lane', planId, laneId: second }
        : { kind: 'plan-decision', planId, decisionId: second };
    }
    const hash = rest.indexOf('#');
    if (hash <= 0 || hash === rest.length - 1) {
      throw new CliUsageError(`invalid --ref ${token}`);
    }
    const repository = rest.slice(0, hash);
    const numberText = rest.slice(hash + 1);
    if (repository.split('/').length !== 2 || !/^\d+$/.test(numberText)) {
      throw new CliUsageError(`invalid --ref ${token}`);
    }
    return { kind: 'pr', repository, number: Number(numberText) };
  }
  throw new CliUsageError(`unknown ref kind in ${token}`);
}

function refTokensFromPayload(payload: Payload): string[] {
  const value = payload['ref'];
  const tokens: string[] = [];
  if (typeof value === 'string') {
    tokens.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') {
        tokens.push(item);
      }
    }
  }
  return tokens;
}

export const ownerItemsCommands: Readonly<Record<string, CommandHandler>> = {
  add: async (p, rt) => {
    for (const key of Object.keys(p)) {
      if (key !== 'projectId' && key !== 'kind' && key !== 'subject' && key !== 'ref') {
        throw new CliUsageError(`Unexpected flag: ${key}`);
      }
    }
    const kind = enumOf(p, 'kind', OWNER_ITEM_KINDS, 'owner-item kind');
    // Absent `--subject` sends null; a present subject is the raw string, including ''.
    const subject = Object.hasOwn(p, 'subject') ? str(p, 'subject') : null;
    const refs = refTokensFromPayload(p).map(typedRef);
    const body = {
      projectId: str(p, 'projectId'),
      kind,
      subject,
      refs,
      blocks: [],
    };
    const result = await rt.coordination.recordOwnerItem.recordOwnerItem(body, 'cli');
    if (result.outcome === 'recorded' || result.outcome === 'exists') {
      return { outcome: result.outcome, itemId: result.item.itemId };
    }
    return result;
  },
  list: async (p, rt) => {
    for (const key of Object.keys(p)) {
      if (key !== 'projectId' && key !== 'state' && key !== 'kind') {
        throw new CliUsageError(`Unexpected flag: ${key}`);
      }
    }
    const filter: Payload = {};
    if (Object.hasOwn(p, 'projectId')) {
      filter['projectId'] = str(p, 'projectId');
    }
    if (Object.hasOwn(p, 'state')) {
      filter['state'] = enumOf(p, 'state', OWNER_ITEM_STATES, 'owner-item state');
    }
    if (Object.hasOwn(p, 'kind')) {
      filter['kind'] = enumOf(p, 'kind', OWNER_ITEM_KINDS, 'owner-item kind');
    }
    const result = await rt.coordination.listOwnerItems.listOwnerItems(filter);
    if (result.outcome === 'unknown' || result.outcome === 'refused') {
      return result;
    }
    if (!Array.isArray(result.items)) {
      return { outcome: 'unknown', reason: 'ListOwnerItems the owner item store could not be read' };
    }
    if (result.truncated) {
      return { outcome: 'listed', truncated: true, items: result.items };
    }
    const lines = result.items.map((entry) =>
      JSON.stringify({
        itemId: entry.item.itemId,
        projectId: entry.item.projectId,
        kind: entry.item.kind,
        state: entry.item.state,
        subject: entry.item.subject,
      }),
    );
    return { outcome: 'listed', truncated: false, lines };
  },
  resolve: async (p, rt) => {
    const positionals = p['positional'];
    const count = Array.isArray(positionals) ? positionals.length : 0;
    if (count !== 1) {
      throw new CliUsageError('owner-items resolve requires exactly one owner item id');
    }
    for (const key of Object.keys(p)) {
      if (key !== 'as' && key !== 'positional') {
        throw new CliUsageError(`Unexpected flag: ${key}`);
      }
    }
    const resolution = enumOf(p, 'as', OWNER_ITEM_RESOLUTION_KINDS, 'resolution');
    if (resolution !== 'done') {
      throw new CliUsageError('only done is supported by owner-items resolve');
    }
    const itemId = firstPositional(p);
    const result = await rt.coordination.resolveOwnerItem.resolveOwnerItem(
      { action: 'done', itemId, via: 'cli' },
      'cli',
    );
    if (result.outcome === 'resolved' || result.outcome === 'unchanged') {
      return { outcome: result.outcome, itemId: result.item.itemId };
    }
    return result;
  },
};
