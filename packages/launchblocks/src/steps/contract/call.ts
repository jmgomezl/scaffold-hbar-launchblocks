import { z } from "zod";

import { DEFAULT_CALL_GAS, callContract, parseFunctionSignature } from "../../hedera/ops/contracts";
import { defineStep } from "../../registry/define-step";
import { CATEGORY_COLOUR, ENTITY_ID_PATTERN, HbarAmountSchema } from "../shared";
import { argFields, argsExpression, collectArgs, contractArgShape } from "./shared";

const InputSchema = z
  .object({
    contractId: z.string().trim().regex(ENTITY_ID_PATTERN, "expected a contract id like 0.0.12345"),
    function: z.string().trim().min(1, "enter a function signature"),
    ...contractArgShape,
    payableHbar: HbarAmountSchema.optional(),
    gas: z.number().int().min(25_000).max(15_000_000).default(DEFAULT_CALL_GAS),
  })
  .superRefine((input, ctx) => {
    let inputs: number;
    try {
      inputs = parseFunctionSignature(input.function).inputs.length;
    } catch {
      ctx.addIssue({
        code: "custom",
        path: ["function"],
        message: "expected a Solidity signature, e.g. function lockedAmount() view returns (uint256)",
      });
      return;
    }
    const { args, gap } = collectArgs(input);
    if (gap) {
      ctx.addIssue({ code: "custom", path: [`arg${gap}`], message: "fill the arguments in order, without gaps" });
    } else if (args.length !== inputs) {
      ctx.addIssue({
        code: "custom",
        path: ["function"],
        message: `the function takes ${inputs} argument${inputs === 1 ? "" : "s"}; ${args.length} filled in`,
      });
    }
  });

export const contractCall = defineStep({
  type: "contract.call",
  input: InputSchema,
  output: z.object({
    contractId: z.string(),
    function: z.string(),
    mode: z.enum(["read", "write"]),
    result: z.string(),
    values: z.array(z.unknown()),
    transactionId: z.string().nullable(),
    gasUsed: z.number().int().nullable(),
  }),
  outputExample: {
    contractId: "0.0.6512600",
    function: "lockedAmount",
    mode: "read",
    result: "70710677118",
    values: ["70710677118"],
    transactionId: null,
    gasUsed: null,
  },
  ui: {
    label: "Call contract",
    category: "contract",
    colour: CATEGORY_COLOUR.contract,
    tooltip:
      "Call a function on a deployed contract. view and pure functions are read for free; others are sent as a transaction.",
    fields: [
      { key: "contractId", label: "Contract", kind: "contractId" },
      {
        key: "function",
        label: "Function",
        kind: "text",
        placeholder: "function lockedAmount() view returns (uint256)",
        help: "The Solidity signature, with view or pure for reads and returns (…) to get results",
      },
      ...argFields,
      { key: "payableHbar", label: "HBAR to send", kind: "amount", help: "Only for a payable function" },
      { key: "gas", label: "Gas limit", kind: "number", help: "Used by transactions; reads are free" },
    ],
    outputs: [
      { key: "result", label: "Result", kind: "value" },
      { key: "transactionId", label: "Call transaction", kind: "transactionId" },
    ],
  },
  docs: {
    summary:
      "Call a contract function: views and pure functions for free through the mirror node, others as a transaction.",
    details: [
      "Takes the function's Solidity signature, so it works with any deployed contract, not only ones from",
      "this project: `function lockedAmount() view returns (uint256)`, or `function release() returns",
      "(uint256)`. Arguments are converted for each parameter's type as in `contract.deploy`.",
      "",
      "`view` and `pure` functions are read through the mirror node's `/contracts/call`, which costs nothing.",
      "The mirror node trails consensus by a few seconds, so the step first waits until it has caught up;",
      "a read straight after a write sees that write. Other functions are sent as a",
      "`ContractExecuteTransaction`, and their return values are decoded from the transaction record.",
      "",
      "`result` is a single return value as a string, or several as a JSON array.",
    ].join("\n"),
    hederaServices: ["SmartContract", "MirrorNode"],
  },
  execute: (input, ctx) => {
    const { args } = collectArgs(input);
    return callContract(
      ctx.hedera,
      {
        contractId: input.contractId,
        function: input.function,
        args,
        gas: input.gas,
        payableHbar: input.payableHbar,
      },
      ctx.signal,
    );
  },
  codegen: ctx => {
    ctx.addImport(ctx.coreModule, "callContract");
    const options = ["gas", "payableHbar"]
      .map(key => `${key}: ${ctx.expr(key)}`)
      .filter(entry => !entry.endsWith(": undefined"));
    return {
      body: [
        `return await callContract(ctx, {`,
        `  contractId: ${ctx.expr("contractId")},`,
        `  function: ${ctx.expr("function")},`,
        `  args: ${argsExpression(ctx)},`,
        ...options.map(entry => `  ${entry},`),
        `});`,
      ].join("\n"),
    };
  },
});
