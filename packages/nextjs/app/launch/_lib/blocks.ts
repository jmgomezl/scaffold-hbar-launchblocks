import { FieldMultilineInput } from "@blockly/field-multilineinput";
import type {
  Catalog,
  EditorDocument,
  EditorStep,
  EditorValue,
  FieldSpec,
  StepCatalogEntry,
  StepCategory,
} from "@sh/launchblocks/editor";
import {
  defaultValue,
  isReferenceKind,
  isValidStepId,
  nextStepId,
  outputsOf,
  parseRef,
  ref,
  renameReferencesInText,
} from "@sh/launchblocks/editor";
import * as Blockly from "blockly/core";

/**
 * Blockly adapter for LaunchBlocks.
 *
 * Every block is generated from the step catalog the API serves, so a new
 * step type in the core package appears in the editor with no changes here.
 * The workspace is read into and written from the pure editor model in
 * `@sh/launchblocks/editor`; this file only knows about blocks.
 *
 * Wiring follows App Inventor: an id input (token, topic, account…) is a
 * socket holding an editable literal, and dragging an output reporter such
 * as `createToken ▸ Token` from the Outputs drawer onto it references that
 * earlier step instead.
 */

export const FLOW_BLOCK = "lb_flow";
export const REF_BLOCK = "lb_ref";
export const LITERAL_BLOCK = "lb_literal";
export const OUTPUTS_CATEGORY = "LB_OUTPUTS";

const STEP_CHECK = "lb_step";
const STEP_PREFIX = "lb_step_";
const ID_FIELD = "__id";
const STATUS_FIELD = "__status";
const NAME_FIELD = "NAME";
const STEPS_INPUT = "STEPS";
const LITERAL_FIELD = "VALUE";
const REF_LABEL_FIELD = "LABEL";

export function blockTypeFor(stepType: string): string {
  return `${STEP_PREFIX}${stepType.replace(/\./g, "_")}`;
}

type StepBlock = Blockly.Block & {
  lbStepType?: string;
  lbExtra?: Record<string, unknown>;
  lbLabel?: string;
};

export type RefState = { stepId: string; key: string; kind: string; label: string; colour: number };
type RefBlock = Blockly.Block & { lbRef?: RefState };

export function isStepBlock(block: Blockly.Block): block is StepBlock {
  return block.type.startsWith(STEP_PREFIX);
}

// ── Block definitions ───────────────────────────────────────────────────────

type Row = { kind: "field"; field: FieldSpec } | { kind: "checks"; title: string; fields: FieldSpec[] };

/** Lay fields out one per row, except runs of checkboxes in the same group (e.g. `keys.*`). */
function rowsFor(fields: readonly FieldSpec[]): Row[] {
  const rows: Row[] = [];
  for (const field of fields) {
    const dot = field.key.lastIndexOf(".");
    const group = dot > 0 ? field.key.slice(0, dot) : null;
    const last = rows[rows.length - 1];
    if (field.kind === "boolean" && group) {
      if (last?.kind === "checks" && last.fields[0]?.key.startsWith(`${group}.`) && last.fields.length < 4) {
        last.fields.push(field);
        continue;
      }
      const continued = last?.kind === "checks" && last.fields[0]?.key.startsWith(`${group}.`);
      rows.push({ kind: "checks", title: continued ? "" : titleCase(group), fields: [field] });
      continue;
    }
    rows.push({ kind: "field", field });
  }
  return rows;
}

function titleCase(path: string): string {
  const word = path.split(".").pop() ?? path;
  return (
    word.charAt(0).toUpperCase() +
    word
      .slice(1)
      .replace(/([A-Z])/g, " $1")
      .toLowerCase()
  );
}

function shortLabel(field: FieldSpec): string {
  return field.label.replace(/\s+key$/i, "").toLowerCase();
}

const idValidator = (value: string) => (isValidStepId(value) ? value : null);
const numberValidator = (value: string) =>
  value === "" || /^-?\d*\.?\d*$/.test(value) || parseRef(value) ? value : null;

function fieldFor(entry: StepCatalogEntry, field: FieldSpec): Blockly.Field {
  const initial = defaultValue(entry, field);
  switch (field.kind) {
    case "select": {
      const options = (field.options ?? []).map(option => [option.label, option.value] as [string, string]);
      const dropdown = new Blockly.FieldDropdown(options);
      if (typeof initial === "string" && options.some(([, value]) => value === initial)) dropdown.setValue(initial);
      return dropdown;
    }
    case "boolean":
      return new Blockly.FieldCheckbox(initial === true ? "TRUE" : "FALSE");
    case "json":
      return new FieldMultilineInput(String(initial));
    case "number":
      return new Blockly.FieldTextInput(String(initial), numberValidator);
    default:
      return new Blockly.FieldTextInput(String(initial));
  }
}

function tooltipFor(entry: StepCatalogEntry): string {
  const helps = entry.ui.fields.filter(field => field.help).map(field => `• ${field.label}: ${field.help}`);
  return [entry.ui.tooltip ?? entry.docs.summary, ...(helps.length ? ["", ...helps] : [])].join("\n");
}

function stepDefinition(entry: StepCatalogEntry) {
  return {
    init(this: StepBlock) {
      this.lbStepType = entry.type;
      this.lbExtra = {};
      this.setColour(entry.ui.colour);
      this.setPreviousStatement(true, STEP_CHECK);
      this.setNextStatement(true, STEP_CHECK);
      this.setInputsInline(false);
      this.setTooltip(tooltipFor(entry));
      this.appendDummyInput("__head")
        .appendField(new Blockly.FieldLabelSerializable(""), STATUS_FIELD)
        .appendField(entry.ui.label)
        .appendField("as")
        .appendField(new Blockly.FieldTextInput(nextStepId(entry.type, []), idValidator), ID_FIELD);

      for (const row of rowsFor(entry.ui.fields)) {
        if (row.kind === "checks") {
          const input = this.appendDummyInput();
          if (row.title) input.appendField(row.title);
          for (const field of row.fields) {
            input.appendField(fieldFor(entry, field), field.key).appendField(shortLabel(field));
          }
        } else if (isReferenceKind(row.field.kind)) {
          this.appendValueInput(row.field.key)
            .setCheck(row.field.kind)
            .setAlign(Blockly.inputs.Align.RIGHT)
            .appendField(row.field.label);
        } else {
          this.appendDummyInput()
            .setAlign(Blockly.inputs.Align.RIGHT)
            .appendField(row.field.label)
            .appendField(fieldFor(entry, row.field), row.field.key);
        }
      }
    },
    saveExtraState(this: StepBlock) {
      return { extra: this.lbExtra ?? {}, ...(this.lbLabel ? { label: this.lbLabel } : {}) };
    },
    loadExtraState(this: StepBlock, state: { extra?: Record<string, unknown>; label?: string } | null) {
      this.lbExtra = state?.extra ?? {};
      if (state?.label) this.lbLabel = state.label;
    },
  };
}

export function applyRef(block: Blockly.Block, state: RefState): void {
  const target = block as RefBlock;
  target.lbRef = state;
  target.setFieldValue(`${state.stepId} ▸ ${state.label}`, REF_LABEL_FIELD);
  target.setOutput(true, state.kind);
  target.setColour(state.colour);
  target.setTooltip(`Output "${state.key}" of step ${state.stepId}, resolved when the flow runs.`);
}

/** Register every block type. Safe to call again (e.g. on hot reload). */
export function defineBlocks(catalog: Catalog): void {
  Blockly.Blocks[FLOW_BLOCK] = {
    init(this: Blockly.Block) {
      this.appendDummyInput()
        .appendField("🚀 Launch")
        .appendField(new Blockly.FieldTextInput("My token launch"), NAME_FIELD)
        .appendField("on testnet");
      this.appendStatementInput(STEPS_INPUT).setCheck(STEP_CHECK);
      this.setColour("#3c3c3c");
      this.setDeletable(false);
      this.setTooltip("Steps inside run top to bottom. Each step can use the outputs of the steps above it.");
    },
  };

  Blockly.Blocks[LITERAL_BLOCK] = {
    init(this: Blockly.Block) {
      this.appendDummyInput().appendField(new Blockly.FieldTextInput(""), LITERAL_FIELD);
      this.setOutput(true, null);
      this.setColour("#9aa4b2");
      this.setTooltip("Type an id such as 0.0.12345, or drop an output from the Outputs drawer here.");
    },
  };

  Blockly.Blocks[REF_BLOCK] = {
    init(this: RefBlock) {
      this.appendDummyInput().appendField(new Blockly.FieldLabelSerializable("?"), REF_LABEL_FIELD);
      this.setOutput(true, null);
      this.setColour(210);
    },
    saveExtraState(this: RefBlock) {
      return this.lbRef ?? null;
    },
    loadExtraState(this: RefBlock, state: RefState | null) {
      if (state) applyRef(this, state);
    },
  };

  for (const entry of catalog.values()) {
    Blockly.Blocks[blockTypeFor(entry.type)] = stepDefinition(entry);
  }
}

// ── Toolbox ─────────────────────────────────────────────────────────────────

const CATEGORY_NAMES: Record<StepCategory, string> = {
  hts: "Tokens · HTS",
  hcs: "Consensus · HCS",
  hss: "Schedules · HSS",
  saucerswap: "SaucerSwap",
  oracle: "Oracles",
  contract: "Contracts",
  util: "Utilities",
};

function literalShadows(entry: StepCatalogEntry) {
  return Object.fromEntries(
    entry.ui.fields
      .filter(field => isReferenceKind(field.kind))
      .map(field => [field.key, { shadow: { type: LITERAL_BLOCK, fields: { [LITERAL_FIELD]: "" } } }]),
  );
}

export function buildToolbox(catalog: Catalog): Blockly.utils.toolbox.ToolboxDefinition {
  const byCategory = new Map<StepCategory, StepCatalogEntry[]>();
  for (const entry of catalog.values()) {
    byCategory.set(entry.ui.category, [...(byCategory.get(entry.ui.category) ?? []), entry]);
  }
  const order = Object.keys(CATEGORY_NAMES) as StepCategory[];
  return {
    kind: "categoryToolbox",
    contents: [
      ...order
        .filter(category => byCategory.has(category))
        .map(category => {
          const entries = byCategory.get(category) ?? [];
          return {
            kind: "category",
            name: CATEGORY_NAMES[category],
            colour: String(entries[0]?.ui.colour ?? 0),
            contents: entries.map(entry => ({
              kind: "block",
              type: blockTypeFor(entry.type),
              inputs: literalShadows(entry),
            })),
          };
        }),
      { kind: "sep" },
      { kind: "category", name: "Outputs", colour: "210", custom: OUTPUTS_CATEGORY },
    ],
  } as Blockly.utils.toolbox.ToolboxDefinition;
}

/** The Outputs drawer lists reporters for what steps inside the Launch block produce. */
export function registerOutputsCategory(workspace: Blockly.WorkspaceSvg, catalog: Catalog): void {
  workspace.registerToolboxCategoryCallback(OUTPUTS_CATEGORY, ws => {
    const contents: Blockly.utils.toolbox.FlyoutItemInfo[] = [];
    for (const step of readDocument(ws, catalog).steps) {
      const colour = catalog.get(step.type)?.ui.colour ?? 210;
      const outputs = outputsOf(step, catalog).filter(output => isReferenceKind(output.kind));
      if (!outputs.length) continue;
      contents.push({ kind: "label", text: step.id });
      for (const output of outputs) {
        const state: RefState = { stepId: step.id, key: output.key, kind: output.kind, label: output.label, colour };
        contents.push({ kind: "block", type: REF_BLOCK, extraState: state } as Blockly.utils.toolbox.FlyoutItemInfo);
      }
    }
    if (!contents.length) {
      contents.push({ kind: "label", text: "Steps inside the Launch block list their outputs here." });
    }
    return contents;
  });
}

// ── Workspace ↔ editor model ────────────────────────────────────────────────

export function flowBlock(workspace: Blockly.Workspace): Blockly.Block | null {
  return workspace.getBlocksByType(FLOW_BLOCK, false)[0] ?? null;
}

export function stepBlocks(workspace: Blockly.Workspace): StepBlock[] {
  return workspace.getAllBlocks(false).filter(isStepBlock);
}

function readSocket(block: Blockly.Block | null): string {
  if (!block) return "";
  if (block.type === REF_BLOCK) {
    const state = (block as RefBlock).lbRef;
    return state ? ref(state.stepId, state.key) : "";
  }
  if (block.type === LITERAL_BLOCK) return String(block.getFieldValue(LITERAL_FIELD) ?? "");
  return "";
}

function readStep(block: StepBlock, entry: StepCatalogEntry): EditorStep {
  const values: Record<string, EditorValue> = {};
  for (const field of entry.ui.fields) {
    if (isReferenceKind(field.kind)) values[field.key] = readSocket(block.getInputTargetBlock(field.key));
    else if (field.kind === "boolean") values[field.key] = block.getFieldValue(field.key) === "TRUE";
    else values[field.key] = String(block.getFieldValue(field.key) ?? "");
  }
  return {
    type: entry.type,
    id: String(block.getFieldValue(ID_FIELD)),
    ...(block.lbLabel ? { label: block.lbLabel } : {}),
    values,
    extra: block.lbExtra ?? {},
  };
}

export type WorkspaceState = {
  name: string;
  steps: EditorStep[];
  /** Step blocks sitting outside the Launch block; they are not part of the flow. */
  detachedIds: string[];
};

export function readDocument(workspace: Blockly.Workspace, catalog: Catalog): WorkspaceState {
  const root = flowBlock(workspace);
  const steps: EditorStep[] = [];
  const attached = new Set<string>();
  let block = root?.getInputTargetBlock(STEPS_INPUT) ?? null;
  while (block) {
    const entry = isStepBlock(block) ? catalog.get(block.lbStepType ?? "") : undefined;
    if (entry) {
      steps.push(readStep(block as StepBlock, entry));
      attached.add(block.id);
    }
    block = block.getNextBlock();
  }
  const detachedIds = stepBlocks(workspace)
    .filter(candidate => !attached.has(candidate.id) && !candidate.isInFlyout)
    .map(candidate => String(candidate.getFieldValue(ID_FIELD)));
  return { name: String(root?.getFieldValue(NAME_FIELD) ?? ""), steps, detachedIds };
}

function outputLabel(stepType: string | undefined, key: string, catalog: Catalog): string {
  const entry = stepType ? catalog.get(stepType) : undefined;
  return entry?.ui.outputs.find(output => output.key === key)?.label ?? key;
}

/** Replace the workspace with `document`. Returns ids of steps that could not be drawn. */
export function writeDocument(workspace: Blockly.WorkspaceSvg, catalog: Catalog, document: EditorDocument): string[] {
  const skipped: string[] = [];
  const typeById = new Map(document.steps.map(step => [step.id, step.type]));
  Blockly.Events.disable();
  try {
    workspace.clear();
    const root = workspace.newBlock(FLOW_BLOCK) as Blockly.BlockSvg;
    root.setFieldValue(document.name, NAME_FIELD);
    root.initSvg();
    root.render();
    root.moveBy(32, 32);

    let connection = root.getInput(STEPS_INPUT)?.connection ?? null;
    for (const step of document.steps) {
      const entry = catalog.get(step.type);
      if (!entry || !connection) {
        skipped.push(step.id);
        continue;
      }
      const block = workspace.newBlock(blockTypeFor(step.type)) as Blockly.BlockSvg & StepBlock;
      block.initSvg();
      if (block.previousConnection) connection.connect(block.previousConnection);
      connection = block.nextConnection;
      block.setFieldValue(step.id, ID_FIELD);
      block.lbExtra = step.extra;
      if (step.label) block.lbLabel = step.label;

      for (const field of entry.ui.fields) {
        const value = step.values[field.key];
        if (isReferenceKind(field.kind)) {
          const socket = block.getInput(field.key)?.connection;
          if (!socket) continue;
          socket.setShadowState({ type: LITERAL_BLOCK, fields: { [LITERAL_FIELD]: "" } });
          const target = parseRef(String(value ?? ""));
          if (target) {
            const reporter = workspace.newBlock(REF_BLOCK) as Blockly.BlockSvg;
            applyRef(reporter, {
              stepId: target.stepId,
              key: target.key,
              kind: field.kind,
              label: outputLabel(typeById.get(target.stepId), target.key, catalog),
              colour: catalog.get(typeById.get(target.stepId) ?? "")?.ui.colour ?? 210,
            });
            reporter.initSvg();
            if (reporter.outputConnection) socket.connect(reporter.outputConnection);
            reporter.render();
          } else {
            socket.targetBlock()?.setFieldValue(String(value ?? ""), LITERAL_FIELD);
          }
        } else if (field.kind === "boolean") {
          block.setFieldValue(value === true ? "TRUE" : "FALSE", field.key);
        } else if (value !== undefined) {
          block.setFieldValue(String(value), field.key);
        }
      }
      block.render();
    }
  } finally {
    Blockly.Events.enable();
  }
  return skipped;
}

// ── Behaviours ──────────────────────────────────────────────────────────────

/**
 * Keep step ids unique (new blocks and pastes get the next free id) and
 * carry a rename through to every output reporter and text reference.
 */
export function stepIdGuard(workspace: Blockly.WorkspaceSvg) {
  return (event: Blockly.Events.Abstract) => {
    if (event.isUiEvent || workspace.isFlyout) return;

    if (event.type === Blockly.Events.BLOCK_CREATE) {
      const created = new Set((event as Blockly.Events.BlockCreate).ids ?? []);
      const blocks = stepBlocks(workspace);
      for (const block of blocks.filter(candidate => created.has(candidate.id))) {
        const id = String(block.getFieldValue(ID_FIELD));
        const taken = blocks.filter(other => other.id !== block.id).map(other => String(other.getFieldValue(ID_FIELD)));
        if (taken.includes(id)) block.setFieldValue(nextStepId(block.lbStepType ?? "step", taken), ID_FIELD);
      }
      return;
    }

    if (event.type === Blockly.Events.BLOCK_CHANGE) {
      const change = event as Blockly.Events.BlockChange;
      if (change.element !== "field" || change.name !== ID_FIELD) return;
      const oldId = String(change.oldValue);
      const newId = String(change.newValue);
      if (!oldId || oldId === newId) return;
      for (const block of workspace.getAllBlocks(false)) {
        if (block.type === REF_BLOCK) {
          const state = (block as RefBlock).lbRef;
          if (state?.stepId === oldId) applyRef(block, { ...state, stepId: newId });
          continue;
        }
        for (const input of block.inputList) {
          for (const field of input.fieldRow) {
            if (!(field instanceof Blockly.FieldTextInput) || !field.name || field.name === ID_FIELD) continue;
            const text = String(field.getValue() ?? "");
            const renamed = renameReferencesInText(text, oldId, newId);
            if (renamed !== text) field.setValue(renamed);
          }
        }
      }
    }
  };
}

export type StepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";

const STATUS_ICON: Record<StepStatus, string> = {
  pending: "⏳",
  running: "⚡",
  succeeded: "✅",
  failed: "❌",
  skipped: "⏭",
};

/** Mark each step block with its run status; runs with events off so it never dirties the flow. */
export function applyStatuses(workspace: Blockly.Workspace, statuses: Record<string, StepStatus | undefined>): void {
  Blockly.Events.disable();
  try {
    for (const block of stepBlocks(workspace)) {
      const status = statuses[String(block.getFieldValue(ID_FIELD))];
      block.setFieldValue(status ? STATUS_ICON[status] : "", STATUS_FIELD);
    }
  } finally {
    Blockly.Events.enable();
  }
}

/** Show validation problems on the blocks they belong to. */
export function applyWarnings(workspace: Blockly.Workspace, warnings: ReadonlyMap<string, string[]>): void {
  const root = flowBlock(workspace);
  let block = root?.getInputTargetBlock(STEPS_INPUT) ?? null;
  const attached = new Set<string>();
  while (block) {
    attached.add(block.id);
    block = block.getNextBlock();
  }
  Blockly.Events.disable();
  try {
    for (const step of stepBlocks(workspace)) {
      if (step.isInFlyout) continue;
      if (!attached.has(step.id)) {
        step.setWarningText("Not part of the launch yet: connect it inside the Launch block.");
        continue;
      }
      const messages = warnings.get(String(step.getFieldValue(ID_FIELD)));
      step.setWarningText(messages?.length ? messages.join("\n") : null);
    }
  } finally {
    Blockly.Events.enable();
  }
}
