import { z } from "zod";

import { CONTRACT_NAME_PATTERN } from "../../contracts/types";
import { LaunchBlocksError } from "../../errors";
import { DEFAULT_DEPLOY_GAS, deployContract } from "../../hedera/ops/contracts";
import { defineStep } from "../../registry/define-step";
import { AmountSchema, CATEGORY_COLOUR, MemoSchema } from "../shared";
import { argFields, argsExpression, collectArgs, contractArgShape } from "./shared";

const InputSchema = z
  .object({
    contract: z
      .string()
      .trim()
      .regex(CONTRACT_NAME_PATTERN, "expected a Solidity contract name like TokenLock, or File.sol:Name"),
    ...contractArgShape,
    autoAssociations: z.number().int().min(-1).max(5000).default(0),
    gas: z.number().int().min(100_000).max(15_000_000).default(DEFAULT_DEPLOY_GAS),
    initialHbar: AmountSchema.optional(),
    adminKey: z.boolean().default(false),
    memo: MemoSchema.optional(),
  })
  .superRefine((input, ctx) => {
    const { gap } = collectArgs(input);
    if (gap)
      ctx.addIssue({ code: "custom", path: [`arg${gap}`], message: "fill the arguments in order, without gaps" });
  });

export const contractDeploy = defineStep({
  type: "contract.deploy",
  input: InputSchema,
  output: z.object({
    contract: z.string(),
    contractId: z.string(),
    accountId: z.string(),
    evmAddress: z.string(),
    transactionId: z.string(),
    gasUsed: z.number().int(),
  }),
  outputExample: {
    contract: "TokenLock",
    contractId: "0.0.6512600",
    accountId: "0.0.6512600",
    evmAddress: "0x0000000000000000000000000000000000635fd8",
    transactionId: "0.0.4242@1758500080.000000001",
    gasUsed: 297662,
  },
  ui: {
    label: "Deploy contract",
    category: "contract",
    colour: CATEGORY_COLOUR.contract,
    tooltip: "Deploy a contract compiled from packages/hardhat/contracts, passing its constructor arguments.",
    fields: [
      {
        key: "contract",
        label: "Contract",
        kind: "text",
        placeholder: "TokenLock",
        help: "Name of a contract in packages/hardhat/contracts, compiled with yarn hardhat:compile",
      },
      ...argFields,
      {
        key: "autoAssociations",
        label: "Token slots",
        kind: "number",
        help: "How many HTS tokens the contract can receive without associating first; -1 for unlimited",
      },
      { key: "gas", label: "Gas limit", kind: "number", advanced: true },
      {
        key: "initialHbar",
        label: "HBAR to send",
        kind: "amount",
        help: "Only for a payable constructor",
        advanced: true,
      },
      {
        key: "adminKey",
        label: "Admin key",
        kind: "boolean",
        help: "Without one the contract can never be changed",
        advanced: true,
      },
    ],
    outputs: [
      { key: "contractId", label: "Contract", kind: "contractId" },
      { key: "accountId", label: "Contract as account", kind: "accountId" },
      { key: "transactionId", label: "Deploy transaction", kind: "transactionId" },
    ],
  },
  docs: {
    summary: "Deploy a Hardhat-compiled contract to Hedera, with constructor arguments and token slots.",
    details: [
      "Loads the contract's ABI and bytecode from `packages/hardhat/artifacts` (run `yarn hardhat:compile`",
      "first) and deploys it with `ContractCreateFlow`: the bytecode goes into a file with FileCreate and",
      "FileAppend, then ContractCreate runs the constructor.",
      "",
      "Arguments are converted for each constructor parameter's type. Entity ids become addresses: accounts",
      "and contracts by their EVM address (an alias-created ECDSA account rejects its long-zero form as a",
      "token recipient), tokens by the long-zero address of their ERC-20 facade. Integers are whole numbers",
      "in smallest units.",
      "",
      "`autoAssociations` gives the contract token slots, so it can receive HTS tokens, such as a pool's LP",
      "tokens, without associating first. The `accountId` output is the same entity as `contractId`, for",
      "wiring the contract into inputs that take an account.",
    ].join("\n"),
    hederaServices: ["SmartContract", "MirrorNode"],
  },
  // Finding a missing contract before the run, not after the token and pool are paid for.
  preflight: async (params, ctx) => {
    const name = params.contract;
    if (typeof name !== "string" || name.includes("{{") || !ctx.artifacts) return;
    await ctx.artifacts(name);
  },
  execute: async (input, ctx) => {
    if (!ctx.artifacts) {
      throw new LaunchBlocksError("CONTRACT_ARTIFACTS_UNAVAILABLE", "This run has no way to load compiled contracts", {
        hint: "Run the flow from the Launch Studio or core:run, which read the Hardhat package's artifacts.",
      });
    }
    const { args } = collectArgs(input);
    return deployContract(
      ctx.hedera,
      {
        artifact: await ctx.artifacts(input.contract),
        args,
        gas: input.gas,
        autoAssociations: input.autoAssociations,
        adminKey: input.adminKey,
        initialHbar: input.initialHbar,
        memo: input.memo,
      },
      ctx.signal,
    );
  },
  codegen: ctx => {
    ctx.addImport(ctx.coreModule, "deployContract", "loadHardhatArtifact");
    const options = ["gas", "autoAssociations", "adminKey", "initialHbar", "memo"]
      .map(key => `${key}: ${ctx.expr(key)}`)
      .filter(entry => !entry.endsWith(": undefined"));
    return {
      body: [
        `return await deployContract(ctx, {`,
        `  artifact: loadHardhatArtifact(${ctx.expr("contract")}),`,
        `  args: ${argsExpression(ctx)},`,
        ...options.map(entry => `  ${entry},`),
        `});`,
      ].join("\n"),
    };
  },
});
