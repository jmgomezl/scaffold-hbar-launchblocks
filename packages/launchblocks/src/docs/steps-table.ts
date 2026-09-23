import type { StepRegistry } from "../registry/registry";
import type { AnyStepDefinition, FieldSpec } from "../registry/types";

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

function inputList(fields: readonly FieldSpec[]): string {
  return fields.map(field => `\`${field.key}\``).join(", ");
}

function outputList(definition: AnyStepDefinition): string {
  return definition.ui.outputs.map(output => `\`${output.key}\``).join(", ");
}

export function renderStepsTable(registry: StepRegistry): string {
  const rows = registry.list().map(step => {
    const services = [...step.docs.hederaServices, ...(step.docs.integrations ?? [])].join(", ");
    return `| \`${step.type}\` | ${escapeCell(step.docs.summary)} | ${services} | ${inputList(step.ui.fields)} | ${outputList(step)} |`;
  });
  return [
    "| Step | What it does | Services | Inputs | Outputs other steps can use |",
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
