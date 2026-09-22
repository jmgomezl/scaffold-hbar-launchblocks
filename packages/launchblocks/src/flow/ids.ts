/**
 * Identifier rules for flows and steps, kept free of zod so the browser
 * editor can apply them without pulling in the schema library.
 *
 * Step ids double as variable names in the generated launch script, so they
 * are constrained to camelCase identifiers that are not JavaScript keywords.
 */

export const STEP_ID_PATTERN = /^[a-z][a-zA-Z0-9]*$/;
export const STEP_TYPE_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/;
export const FLOW_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export const JS_RESERVED_WORDS = new Set([
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

/** Identifiers the runner and codegen use themselves; a step cannot shadow them. */
export const LAUNCHBLOCKS_RESERVED_IDS = new Set([
  "steps",
  "outputs",
  "ctx",
  "client",
  "flow",
  "operator",
  "operatorId",
  "operatorKey",
  "step",
  "main",
]);

/** True when `id` is usable as a step id (pattern, length, not reserved). */
export function isValidStepId(id: string): boolean {
  return (
    id.length > 0 &&
    id.length <= 40 &&
    STEP_ID_PATTERN.test(id) &&
    !JS_RESERVED_WORDS.has(id) &&
    !LAUNCHBLOCKS_RESERVED_IDS.has(id)
  );
}
