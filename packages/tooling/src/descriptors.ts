import { AGY_TOOL } from './agy.js';
import { CLAUDE_CODE_TOOL } from './claude-code.js';
import { GROK_TOOL } from './grok.js';
import { OPENCODE_TOOL } from './opencode.js';
import type { ToolDescriptor, ToolId } from './types.js';

/** Every product-shipped descriptor, in the order init and doctor list tools. */
export const BUILT_IN_TOOLS: readonly ToolDescriptor[] = [
  CLAUDE_CODE_TOOL,
  OPENCODE_TOOL,
  GROK_TOOL,
  AGY_TOOL,
];

const BUILT_IN_IDS: ReadonlySet<string> = new Set(BUILT_IN_TOOLS.map((tool) => tool.id));

/** True when `value` names a built-in tool; for validating seat `tool` fields. */
export function isToolId(value: unknown): value is ToolId {
  return typeof value === 'string' && BUILT_IN_IDS.has(value);
}
