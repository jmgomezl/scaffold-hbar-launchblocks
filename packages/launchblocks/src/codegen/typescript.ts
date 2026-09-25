import { findRefs, isPlainObject, parseRef, resolveRefs } from "../flow/refs";
import type { ZodType } from "zod";

import type { Flow } from "../flow/schema";
import type { StepRegistry } from "../registry/registry";
import type { CodegenContext } from "../registry/types";

export type CodegenOptions = {
  /** Module the generated file imports core helpers from. */
  coreModule?: string;
  /** Extra comment lines for the file header (e.g. a timestamp or source path). */
  headerLines?: readonly string[];
};

const DEFAULT_CORE_MODULE = "@sh/launchblocks";

/** Names the generated script defines itself, which a step's variable must not shadow. */
const SCRIPT_NAMES = ["step", "required", "main", "ctx", "client", "operatorId", "operatorKey", "console", "process"];

/** How a reference renders: the variable holding each step's outputs, and which outputs may be null. */
export type RefRendering = {
  variable?: (stepId: string) => string;
  nullable?: (stepId: string, key: string) => boolean;
};

/**
 * Render a validated flow as a TypeScript script that performs the same
 * steps by calling this package's operations; it runs anywhere
 * `@sh/launchblocks` resolves (inside this repo). Each step's body runs
 * inside its own async closure and its returned outputs become a `const`
 * named after the step id, so later steps reference `createToken.tokenId`
 * exactly as the flow JSON did with `{{steps.createToken.tokenId}}`. A step
 * whose id matches an imported operation gets `<id>Result` instead.
 */
export function generateLaunchScript(document: unknown, registry: StepRegistry, options: CodegenOptions = {}): string {
  const flow = registry.validateFlow(document);
  const coreModule = options.coreModule ?? DEFAULT_CORE_MODULE;

  // Outputs whose schema admits null: a whole reference to one is checked at run time.
  const nullable = new Set<string>();
  for (const step of flow.steps) {
    const output = registry.get(step.type).output as unknown as { shape?: Record<string, ZodType> };
    for (const [key, schema] of Object.entries(output.shape ?? {})) {
      if (schema.safeParse(null).success) nullable.add(`${step.id}.${key}`);
    }
  }

  const render = (rendering: RefRendering) => {
    const imports = new ImportCollector();
    imports.add(coreModule, "hederaContextFromEnv");
    /** Example outputs of earlier steps, so defaults can be computed with references in place. */
    const exampleOutputs: Record<string, Record<string, unknown>> = {};
    const sections = flow.steps.map((step, index) => {
      const definition = registry.get(step.type);
      const params = paramsWithDefaults(step.params, definition.input, exampleOutputs);
      exampleOutputs[step.id] = definition.outputExample;
      const ctx: CodegenContext = {
        stepId: step.id,
        coreModule,
        expr: key => renderExpr(params[key], rendering),
        addImport: (specifier, ...names) => imports.add(specifier, ...names),
      };
      const fragment = definition.codegen(ctx);
      const title = step.label ? `${step.label} (${step.type})` : step.type;
      const variable = rendering.variable?.(step.id) ?? step.id;
      return [
        `  // ${index + 1}. ${step.id}: ${oneLine(title)}`,
        `  const ${variable} = await step("${step.id}", async () => {`,
        indent(fragment.body.trim(), 4),
        `  });`,
      ].join("\n");
    });
    return { imports, sections };
  };

  // The first pass only learns which operations get imported; the second names variables around them.
  const taken = new Set([...render({}).imports.names(), ...SCRIPT_NAMES]);
  const variables = new Map<string, string>();
  for (const step of flow.steps) {
    let name = taken.has(step.id) ? `${step.id}Result` : step.id;
    while (taken.has(name)) name = `${name}_`;
    taken.add(name);
    variables.set(step.id, name);
  }
  const { imports, sections } = render({
    variable: id => variables.get(id) ?? id,
    nullable: (id, key) => nullable.has(`${id}.${key}`),
  });
  const body = sections.join("\n\n");

  const summary = flow.steps
    .map(step => (variables.get(step.id) === step.id ? step.id : `${step.id}: ${variables.get(step.id)}`))
    .join(", ");

  return [
    header(flow, options.headerLines ?? []),
    imports.render(),
    "",
    STEP_HELPER,
    ...(body.includes("required(") ? ["", REQUIRED_HELPER] : []),
    "",
    `async function main(): Promise<void> {`,
    `  const ctx = hederaContextFromEnv(process.env, { network: ${JSON.stringify(flow.network)} });`,
    `  const { client, operatorId, operatorKey } = ctx;`,
    `  console.log(\`Running flow ${flow.id} on ${flow.network} as \${operatorId.toString()}\`);`,
    "",
    body,
    "",
    `  console.log("Flow complete", { ${summary} });`,
    `  client.close();`,
    `}`,
    "",
    `main().catch(error => {`,
    `  console.error(error);`,
    `  process.exitCode = 1;`,
    `});`,
    "",
  ].join("\n");
}

/**
 * Apply the input schema's defaults without losing references: parse a copy
 * where references are replaced by example outputs, then let the original
 * (reference-bearing) values win for every key the author wrote.
 */
function paramsWithDefaults(
  params: Record<string, unknown>,
  input: ZodType,
  exampleOutputs: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  const parsed = input.parse(resolveRefs(params, exampleOutputs));
  return isPlainObject(parsed) ? { ...parsed, ...params } : params;
}

/** Text for a line comment: a line break in a label must not end the comment. */
function oneLine(text: string): string {
  return text.replace(/[\r\n\u2028\u2029]+/g, " ");
}

function header(flow: Flow, extra: readonly string[]): string {
  const lines = [
    `Generated by LaunchBlocks from flow "${flow.id}" (${oneLine(flow.name)}).`,
    ...(flow.description ? ["", ...flow.description.split(/\r?\n|\u2028|\u2029/)] : []),
    "",
    "Regenerate from the flow JSON instead of editing by hand.",
    `Requires HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY for ${flow.network}.`,
    ...(extra.length ? ["", ...extra] : []),
  ];
  // "*/" inside the text would close the comment early.
  const safe = (line: string) => line.replace(/\*\//g, "*\\/");
  return ["/**", ...lines.map(line => (line ? ` * ${safe(line)}` : " *")), " */"].join("\n");
}

const STEP_HELPER = `/** Runs one step, printing its timing and outputs. */
async function step<T>(id: string, run: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  console.log(\`▶ \${id}\`);
  try {
    const outputs = await run();
    console.log(\`✔ \${id} (\${Date.now() - startedAt} ms)\`, outputs);
    return outputs;
  } catch (error) {
    console.error(\`✖ \${id} failed\`, error);
    throw error;
  }
}`;

const REQUIRED_HELPER = `/** An output the flow needs but the step did not produce, e.g. a pool the mirror node never showed. */
function required<T>(value: T | null | undefined, name: string): T {
  if (value === null || value === undefined) throw new Error(\`\${name} is missing\`);
  return value;
}`;

class ImportCollector {
  private readonly bySpecifier = new Map<string, Set<string>>();

  names(): string[] {
    return [...this.bySpecifier.values()].flatMap(set => [...set]);
  }

  add(specifier: string, ...names: string[]): void {
    const set = this.bySpecifier.get(specifier) ?? new Set<string>();
    names.forEach(name => set.add(name));
    this.bySpecifier.set(specifier, set);
  }

  render(): string {
    return [...this.bySpecifier.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([specifier, names]) => `import { ${[...names].sort().join(", ")} } from ${JSON.stringify(specifier)};`)
      .join("\n");
  }
}

/**
 * TypeScript expression for a flow param value. Whole references become
 * `<stepId>.<key>`, interpolated strings become template literals, and
 * arrays/objects are rendered recursively so nested references survive.
 */
export function renderExpr(value: unknown, rendering: RefRendering = {}): string {
  if (value === undefined) return "undefined";
  if (typeof value === "string") {
    const whole = parseRef(value);
    if (whole) {
      const access = `${rendering.variable?.(whole.stepId) ?? whole.stepId}.${whole.key}`;
      return rendering.nullable?.(whole.stepId, whole.key)
        ? `required(${access}, ${JSON.stringify(`${whole.stepId}.${whole.key}`)})`
        : access;
    }
    if (findRefs(value).length === 0) return JSON.stringify(value);
    return renderTemplateLiteral(value, rendering);
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => renderExpr(item, rendering)).join(", ")}]`;
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value).map(([key, item]) => `${renderKey(key)}: ${renderExpr(item, rendering)}`);
    return entries.length ? `{ ${entries.join(", ")} }` : "{}";
  }
  return JSON.stringify(value);
}

function renderTemplateLiteral(value: string, rendering: RefRendering): string {
  const pattern = /\{\{\s*steps\.([a-z][a-zA-Z0-9]*)\.([a-z][a-zA-Z0-9]*)\s*\}\}/g;
  let out = "`";
  let last = 0;
  for (const match of value.matchAll(pattern)) {
    out += escapeTemplateText(value.slice(last, match.index));
    out += `\${${rendering.variable?.(match[1] as string) ?? match[1]}.${match[2]}}`;
    last = match.index + match[0].length;
  }
  out += escapeTemplateText(value.slice(last));
  return out + "`";
}

function escapeTemplateText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

function renderKey(key: string): string {
  // `__proto__: …` in an object literal sets the prototype instead of a property; a computed key does not.
  if (key === "__proto__") return '["__proto__"]';
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map(line => (line.trim() ? pad + line : line))
    .join("\n");
}
