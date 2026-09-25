import type { StepRegistry } from "../registry/registry";
import type { AnyStepDefinition } from "../registry/types";
import { paramKeys } from "../registry/unknown-keys";

/**
 * Markdown reference for every registered step, generated from the step
 * definitions themselves so the README cannot drift from the code.
 * `yarn core:docs` writes it between the markers; `--check` fails CI when the
 * committed README is stale.
 */

export const STEPS_START = "<!-- launchblocks:steps:start -->";
export const STEPS_END = "<!-- launchblocks:steps:end -->";

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n+/g, " ");
}

/**
 * A step's params as the JSON writes them: nested ones inside their object
 * (`keys: { admin, supply }`), then those only JSON sets, not the editor.
 */
function paramList(definition: AnyStepDefinition): string {
  const groups = new Map<string, string[]>();
  for (const field of definition.ui.fields) {
    const [head = field.key, ...rest] = field.key.split(".");
    groups.set(head, [...(groups.get(head) ?? []), ...(rest.length ? [rest.join(".")] : [])]);
  }
  const shown = [...groups].map(([key, nested]) =>
    nested.length ? `\`${key}: { ${nested.join(", ")} }\`` : `\`${key}\``,
  );
  const jsonOnly = paramKeys(definition.input).filter(key => !groups.has(key));
  return [
    shown.join(", "),
    ...(jsonOnly.length ? [`JSON only: ${jsonOnly.map(key => `\`${key}\``).join(", ")}`] : []),
  ].join("; ");
}

function outputList(definition: AnyStepDefinition): string {
  return definition.ui.outputs.map(output => `\`${output.key}\``).join(", ");
}

export function renderStepsTable(registry: StepRegistry): string {
  const rows = registry.list().map(step => {
    const services = [...step.docs.hederaServices, ...(step.docs.integrations ?? [])].join(", ");
    return `| \`${step.type}\` | ${escapeCell(step.docs.summary)} | ${services} | ${paramList(step)} | ${outputList(step)} |`;
  });
  return [
    "| Step | What it does | Services | Params | Outputs other steps can use |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

/** Replace the content between the markers; throws if they are missing. */
export function injectBetweenMarkers(document: string, content: string, start = STEPS_START, end = STEPS_END): string {
  const from = document.indexOf(start);
  const to = document.indexOf(end);
  if (from < 0 || to < 0 || to < from) {
    throw new Error(`Markers ${start} … ${end} not found in the document`);
  }
  return `${document.slice(0, from + start.length)}\n${content}\n${document.slice(to)}`;
}
