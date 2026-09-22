import { describe, expect, it } from "vitest";

import {
  deletePath,
  editorToFlow,
  flowIdFromName,
  flowToEditor,
  getPath,
  indexCatalog,
  newStep,
  nextStepId,
  outputsOf,
  referenceOptions,
  renameReferencesInText,
  renameStepReferences,
  schemaDefault,
  setPath,
  stepToParams,
  toParam,
} from "../../src/editor/model";
import type { EditorDocument } from "../../src/editor/model";
import { ref } from "../../src/flow/refs";
import { GALLERY } from "../../src/gallery";
import { stepCatalog } from "../../src/registry/catalog";
import { createDefaultRegistry } from "../../src/steps";

const registry = createDefaultRegistry();
const catalog = indexCatalog(stepCatalog(registry));
const entry = (type: string) => {
  const found = catalog.get(type);
  if (!found) throw new Error(`missing ${type}`);
  return found;
};

describe("path helpers", () => {
  it("get, set and delete nested paths, pruning emptied parents", () => {
    const target: Record<string, unknown> = {};
    setPath(target, "a.b.c", 1);
    setPath(target, "a.d", 2);
    expect(getPath(target, "a.b.c")).toBe(1);
    deletePath(target, "a.b.c");
    expect(target).toEqual({ a: { d: 2 } });
    deletePath(target, "a.d");
    expect(target).toEqual({});
  });

  it("ignores paths that do not exist", () => {
    const target = { a: 1 };
    deletePath(target, "x.y");
    expect(target).toEqual({ a: 1 });
    expect(getPath(target, "a.b")).toBeUndefined();
  });
});

describe("schemaDefault()", () => {
  const createToken = entry("hts.createToken");

  it("reads leaf defaults", () => {
    expect(schemaDefault(createToken.inputSchema, "decimals")).toBe(8);
    expect(schemaDefault(createToken.inputSchema, "supplyType")).toBe("infinite");
  });

  it("reads defaults nested inside a group", () => {
    expect(schemaDefault(createToken.inputSchema, "keys.admin")).toBe(true);
    expect(schemaDefault(createToken.inputSchema, "keys.kyc")).toBe(false);
  });

  it("returns undefined where there is no default", () => {
    expect(schemaDefault(createToken.inputSchema, "name")).toBeUndefined();
    expect(schemaDefault(createToken.inputSchema, "nope.nothing")).toBeUndefined();
  });
});

describe("ids", () => {
  it("derives step ids from the action and avoids collisions", () => {
    expect(nextStepId("hts.createToken", [])).toBe("createToken");
    expect(nextStepId("hts.createToken", ["createToken"])).toBe("createToken2");
    expect(nextStepId("hts.createToken", ["createToken", "createToken2"])).toBe("createToken3");
  });

  it("steers around reserved identifiers", () => {
    expect(nextStepId("util.step", [])).toBe("stepStep");
    expect(nextStepId("util.new", [])).toBe("newStep");
  });

  it("builds kebab-case flow ids from names", () => {
    expect(flowIdFromName("My Launch!")).toBe("my-launch");
    expect(flowIdFromName("  Lanzamiento Ñandú 2026 ")).toBe("lanzamiento-nandu-2026");
    expect(flowIdFromName("!!!")).toBe("my-launch");
    expect(flowIdFromName("x".repeat(80))).toHaveLength(64);
  });
});

describe("newStep()", () => {
  it("fills every field with the schema's default", () => {
    const step = newStep(entry("hts.createToken"), []);
    expect(step.id).toBe("createToken");
    expect(step.values).toMatchObject({
      name: "",
      decimals: "8",
      initialSupply: "1000000",
      supplyType: "infinite",
      "keys.admin": true,
      "keys.freeze": false,
      "fractionalFee.assessment": "inclusive",
    });
  });
});

describe("toParam()", () => {
  const field = (kind: Parameters<typeof toParam>[0]["kind"]) => ({ key: "k", label: "K", kind });

  it("omits empty free-form values", () => {
    expect(toParam(field("text"), "  ")).toBeUndefined();
    expect(toParam(field("number"), "")).toBeUndefined();
  });

  it("parses numbers but keeps references and garbage as typed", () => {
    expect(toParam(field("number"), "18")).toBe(18);
    expect(toParam(field("number"), ref("a", "decimals"))).toBe("{{steps.a.decimals}}");
    expect(toParam(field("number"), "12abc")).toBe("12abc");
  });

  it("keeps amounts as strings so large values survive", () => {
    expect(toParam(field("amount"), "50000000000")).toBe("50000000000");
  });

  it("parses JSON objects and arrays, and falls back to plain text", () => {
    expect(toParam(field("json"), '{"a":1}')).toEqual({ a: 1 });
    expect(toParam(field("json"), "[1,2]")).toEqual([1, 2]);
    expect(toParam(field("json"), "launched!")).toBe("launched!");
    expect(toParam(field("json"), "42")).toBe("42");
  });

  it("reads booleans from checkboxes", () => {
    expect(toParam(field("boolean"), true)).toBe(true);
    expect(toParam(field("boolean"), false)).toBe(false);
  });
});

describe("stepToParams()", () => {
  const createToken = entry("hts.createToken");

  it("drops an optional group whose free-form fields are empty", () => {
    const step = newStep(createToken, []);
    step.values.name = "Demo";
    step.values.symbol = "DMO";
    const params = stepToParams(createToken, step);
    expect(params.fractionalFee).toBeUndefined();
    expect(params.fixedHbarFee).toBeUndefined();
    expect(params.keys).toMatchObject({ admin: true, supply: true });
  });

  it("keeps a group once one free-form field is filled", () => {
    const step = newStep(createToken, []);
    step.values["fractionalFee.numerator"] = "1";
    step.values["fractionalFee.denominator"] = "100";
    expect(stepToParams(createToken, step).fractionalFee).toEqual({
      numerator: 1,
      denominator: 100,
      assessment: "inclusive",
    });
  });

  it("merges params no field represents back in", () => {
    const step = newStep(createToken, []);
    step.values["fractionalFee.numerator"] = "1";
    step.values["fractionalFee.denominator"] = "100";
    step.extra = { fractionalFee: { min: "0.5" } };
    expect(stepToParams(createToken, step).fractionalFee).toEqual({
      numerator: 1,
      denominator: 100,
      assessment: "inclusive",
      min: "0.5",
    });
  });

  it("does not resurrect a dropped group from extra", () => {
    const step = newStep(createToken, []);
    step.extra = { fractionalFee: { min: "0.5" } };
    expect(stepToParams(createToken, step).fractionalFee).toBeUndefined();
  });
});

describe("gallery round trip", () => {
  it.each(GALLERY.map(item => [item.id, item] as const))("%s survives flow → editor → flow", (_id, item) => {
    const { document, problems } = flowToEditor(item.flow, catalog);
    expect(problems).toEqual([]);

    const flow = editorToFlow(document, catalog);
    expect(registry.checkFlow(flow).issues).toEqual([]);
    expect(flow.steps.map(step => step.id)).toEqual(item.flow.steps.map(step => step.id));

    // Every param the author wrote comes back with the same value.
    item.flow.steps.forEach((original, index) => {
      const params = flow.steps[index]?.params ?? {};
      expect(params).toMatchObject(original.params ?? {});
    });
  });

  it("keeps references and nested messages intact", () => {
    const launch = GALLERY.find(item => item.id === "hts-launch-saucerswap");
    if (!launch) throw new Error("gallery flow missing");
    const { document } = flowToEditor(launch.flow, catalog);
    const seedPool = document.steps.find(step => step.id === "seedPool");
    expect(seedPool?.values.tokenId).toBe("{{steps.createToken.tokenId}}");
    const record = document.steps.find(step => step.id === "recordMarket");
    expect(JSON.parse(String(record?.values.message))).toMatchObject({ pairId: "{{steps.seedPool.pairId}}" });
  });
});

describe("unknown step types", () => {
  it("are reported and preserved rather than dropped", () => {
    const { document, problems } = flowToEditor(
      {
        schemaVersion: 1,
        id: "x",
        name: "x",
        steps: [{ id: "mystery", type: "future.thing", params: { a: 1 } }],
      },
      catalog,
    );
    expect(problems).toEqual([{ stepId: "mystery", message: 'unknown step type "future.thing"' }]);
    expect(editorToFlow(document, catalog).steps[0]?.params).toEqual({ a: 1 });
  });
});

describe("wiring helpers", () => {
  const document: EditorDocument = {
    id: "w",
    name: "w",
    network: "testnet",
    steps: [
      newStep(entry("hts.createToken"), []),
      newStep(entry("hcs.createTopic"), ["createToken"]),
      newStep(entry("hts.mint"), ["createToken", "createTopic"]),
    ],
  };

  it("lists a step's outputs as references", () => {
    expect(outputsOf(document.steps[0] as never, catalog).map(o => o.reference)).toContain(
      "{{steps.createToken.tokenId}}",
    );
  });

  it("offers only earlier outputs of the matching kind", () => {
    expect(referenceOptions(document.steps, 2, "tokenId", catalog).map(o => o.reference)).toEqual([
      "{{steps.createToken.tokenId}}",
    ]);
    expect(referenceOptions(document.steps, 0, "tokenId", catalog)).toEqual([]);
    expect(referenceOptions(document.steps, 2, "topicId", catalog).map(o => o.stepId)).toEqual(["createTopic"]);
  });

  it("renames a step and every reference to it", () => {
    const steps = document.steps.map(step => ({ ...step, values: { ...step.values } }));
    (steps[2] as (typeof steps)[number]).values.tokenId = "{{ steps.createToken.tokenId }}";
    (steps[1] as (typeof steps)[number]).values.memo = "log for {{steps.createToken.symbol}}";
    const renamed = renameStepReferences(steps, "createToken", "launchToken");
    expect(renamed[0]?.id).toBe("launchToken");
    expect(renamed[2]?.values.tokenId).toBe("{{ steps.launchToken.tokenId }}");
    expect(renamed[1]?.values.memo).toBe("log for {{steps.launchToken.symbol}}");
  });

  it("renames references inside a single string", () => {
    expect(renameReferencesInText('{"t":"{{steps.a.tokenId}}","u":"{{steps.ab.tokenId}}"}', "a", "b")).toBe(
      '{"t":"{{steps.b.tokenId}}","u":"{{steps.ab.tokenId}}"}',
    );
  });

  it("does not rename ids that merely share a prefix", () => {
    const steps = [{ ...newStep(entry("hts.mint"), []), values: { tokenId: "{{steps.createToken2.tokenId}}" } }];
    expect(renameStepReferences(steps, "createToken", "x")[0]?.values.tokenId).toBe("{{steps.createToken2.tokenId}}");
  });
});
