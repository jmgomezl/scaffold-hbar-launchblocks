# Agent instructions

Briefing for coding agents in this app (Cursor, Claude Code, Codex). Claude Code loads it through `CLAUDE.md`.

This is **LaunchBlocks**, a Scaffold-HBAR template: a visual, block-based HTS token launchpad on Hedera. A launch is a *flow* (ordered JSON steps) that the app renders as Blockly blocks, runs from Next.js API routes with an operator key (or in the page, signed by a visitor's Hedera wallet), and exports as a standalone `launch.ts`. Next.js App Router, wallet connect, Debug Contracts, and Hedera networks (testnet, mainnet, local fork). The CLI may have left only Hardhat or only Foundry.

Use the package manager this project was created with — see `packageManager` in the root `package.json`, or the lockfile. The command examples below are written for the package manager this copy was scaffolded with; run the same script names through whichever one the project uses.

## Packages

- `packages/launchblocks` (`@sh/launchblocks`) — framework-agnostic core: flow schema, step registry, runner, codegen, Hedera client factory. No React, no Next. Unit-tested with vitest.
- `packages/nextjs` — the frontend (App Router, RainbowKit, Wagmi, Viem, DaisyUI) plus the API routes that run flows.
- `packages/hardhat` exists → Hardhat (`hardhat-deploy`); `packages/foundry` exists → Foundry (Forge scripts). Follow only the flavor that is present.

Product rules that shape every change:

1. **Flows are JSON, the editor is optional.** Anything the block editor can do must work from a flow JSON file through the runner and the API. Never put logic in the editor that the runner does not have.
2. **No general-purpose blocks.** No if/loop/variable blocks. Every block is exactly one step type in the registry.
3. **One hero use case.** The HTS launch → SaucerSwap pool flow is the headline; other steps and gallery flows are "also included".
4. **Never log or return an operator key.** `HederaContext` holds it; nothing serializes it.
5. **Every step works with a wallet too.** A wallet context has `hedera.signer` and no `operatorKey`. Send transactions through `send`, `submit` or `sendContract` (`hedera/ops/submit.ts`), never `execute` directly, and when `hedera.signer` is set, read from the mirror node (`hedera/mirror.ts`) instead of paid queries such as `TokenInfoQuery`: the wallet would have to approve each one.

## Commands

Package-prefixed scripts for package-specific work. Keep only truly cross-workspace commands unprefixed.

```bash
# Local chain + deploy + frontend (separate terminals)
yarn hardhat:chain    # Hedera-forked Hardhat node on 8545
yarn hardhat:deploy --network localhost
yarn foundry:chain    # Anvil from the Foundry package
yarn foundry:deploy
yarn next:start       # http://localhost:3000

# Frontend only
yarn next:dev

# Quality / build
yarn lint             # next + hardhat + core
yarn check-types      # next + hardhat + core
yarn test             # core (vitest) + hardhat
yarn format
yarn next:build
yarn hardhat:compile
yarn foundry:compile

# Core package only
yarn core:test
yarn core:test:coverage
yarn core:lint
yarn core:check-types
yarn core:harness <flow.json>   # export a flow as a Hedera Harness recipe into .harness/

# Live networks
yarn hardhat:deploy --network hederaTestnet   # or hederaMainnet
yarn foundry:deploy --network hedera_testnet  # or hedera_mainnet
yarn hardhat:verify:testnet
yarn foundry:verify:testnet

# Deployer account
yarn hardhat:account:generate
yarn hardhat:account:import
yarn hardhat:account
```

`yarn hardhat:deploy` without `--network localhost` targets the in-process `hardhat` network, not the long-running fork.

## Layout

### LaunchBlocks core (`packages/launchblocks`)

```
src/
  flow/       schema.ts (FlowSchema, step ids/types), refs.ts ({{steps.<id>.<key>}} resolution)
  registry/   types.ts (StepDefinition contract), define-step.ts, registry.ts (createRegistry, validateFlow)
  runner/     runner.ts (runFlow → RunResult with per-step records, links, events)
  codegen/    typescript.ts (generateLaunchScript, renderExpr)
  contracts/  artifacts.ts (loadHardhatArtifact: ABI and bytecode from packages/hardhat/artifacts; node only)
  harness/    recipe.ts (generateHarnessRecipe: a flow → a Hedera Harness recipe; STEP_FEE_HBAR cost table)
  hedera/     context.ts (HederaContext, hashscanUrl), client.ts (createHederaContext, hederaContextFromEnv),
              wallet.ts (walletHederaContext: a connected wallet signs), mirror.ts (mirror node reads),
              ops/submit.ts (send, submit, sendContract: operator or wallet), errors.ts (translate statuses and wallet refusals)
  saucerswap/ config.ts (deployments), pool.ts, swap.ts: the SaucerSwap V1 operations
  pyth/       config.ts (Pyth's Hedera contract, feed ids), hermes.ts (signed updates, API key), price.ts (priceInUsd)
  steps/      one folder per namespace (hts/, hcs/, hss/, pyth/, saucerswap/, contract/), one file per step type
  errors.ts   LaunchBlocksError subclasses with stable `code`s
  browser.ts  the entry for wallet runs in the page (no Node built-ins); editor/ is the editor's entry
test/         mirrors src/; test/helpers/fake-steps.ts has network-free steps for runner/registry tests
```

A **flow** is `{ schemaVersion: 1, id, name, network, steps: [{ id, type, params }] }`. Step ids are camelCase and become variable names in generated code. Params may reference earlier outputs with `{{steps.<id>.<key>}}` — a whole-string reference keeps the output's type; inside longer strings it interpolates.

A **step definition** (`defineStep({...})`) bundles, in one object:

| Field | Purpose |
| --- | --- |
| `type` | `namespace.action`, e.g. `hts.createToken` |
| `input` / `output` | zod schemas; `input` is parsed after references resolve |
| `outputExample` | a complete, realistic output — used to type-check wiring before running and as the docs example |
| `ui` | label, category, colour, `fields` (param → editor field) and `outputs` (what later steps may reference) |
| `docs` | one-line summary, markdown details, Hedera services and integrations touched |
| `execute(input, ctx)` | the SDK calls; throw `StepExecutionError` with a `hint` for user-fixable failures |
| `codegen(ctx)` | body of an async function that does the same with the SDK and `return`s the outputs; use `ctx.expr(key)` for params and `ctx.addImport()` for imports |

#### Adding a step type

1. Create `packages/launchblocks/src/steps/<namespace>/<action>.ts` exporting `defineStep({...})`. Reuse the field kinds in `registry/types.ts` (`tokenId`, `accountId`, `topicId`, `amount`, …) — kinds drive which earlier outputs the editor offers to an input. Entity ids, `amount` and `value` are sockets; a `value` socket takes any output, for generic inputs like contract arguments.
2. Register it in `packages/launchblocks/src/steps/index.ts` (the built-in registry).
3. Add `test/steps/<namespace>/<action>.test.ts`: validate `input`/`outputExample`, run `codegen` and assert the body, and test `execute` against a stubbed `HederaContext` — no network in unit tests. If the step reads anything back, cover the wallet path as `test/hedera/wallet.test.ts` does.
4. If it produces on-chain entities, list them in `ui.outputs` with the right kind so the runner emits Hashscan links.
5. If its network fee is not small, add it to `STEP_FEE_HBAR` in `src/harness/recipe.ts`; exported recipes fund on-chain checks from that table, and unlisted types count as 2 ℏ.
6. Run `yarn core:test && yarn core:lint --max-warnings=0 && yarn core:check-types`.

The editor and API discover steps through the registry; there is nothing to register in `packages/nextjs`.

`.harness/` holds a hedera-harness recipe that exercises exactly this recipe (adding `hts.burn`). Its `prd.md` is a worked example of the change.

`yarn core:harness <flow.json>` (or **Export → Harness recipe** in the studio) turns any flow into a recipe of its own, `.harness/<flow-id>.spec.yaml` plus `.harness/<flow-id>/`, that asks an agent to add the flow to the gallery unchanged. Keep each spec directly in `.harness/`: the harness takes the spec's parent directory as the project root.

### Hardhat

- Contracts: `packages/hardhat/contracts/`
- Deploy scripts: `packages/hardhat/deploy/`
- Tests: `packages/hardhat/test/`
- Config: `packages/hardhat/hardhat.config.ts`
- Tagged deploy: if `deployHederaToken.tags = ["HederaToken"]`, run `yarn hardhat:deploy --tags HederaToken`

### Foundry

- Contracts: `packages/foundry/contracts/`
- Deploy scripts: `packages/foundry/script/` (`Deploy.s.sol`, `DeployHederaToken.s.sol`, `DeployHtsTokenCreator.s.sol`)
- Tests: `packages/foundry/test/`
- Config: `packages/foundry/foundry.toml`
- One contract: `yarn foundry:deploy --file DeployHederaToken.s.sol`

### After deploy

ABIs and addresses are written to `packages/nextjs/contracts/deployedContracts.ts`. Put third-party contracts in `packages/nextjs/contracts/externalContracts.ts`.

Sample contracts on this starter: `HederaToken` (ERC-20) and `HtsTokenCreator` (HTS precompile at `0x167`).

## Frontend contract interaction

Hooks live in `packages/nextjs/hooks/scaffold-hbar`. Use the names that exist in the codebase:

- `useScaffoldReadContract` — not `useScaffoldContractRead`
- `useScaffoldWriteContract` — not `useScaffoldContractWrite`

Also: `useScaffoldWatchContractEvent`, `useScaffoldEventHistory`, `useDeployedContractInfo`, `useScaffoldContract`, `useTransactor`.

```typescript
const { data: balance } = useScaffoldReadContract({
  contractName: "HederaToken",
  functionName: "balanceOf",
  args: [connectedAddress],
});

const { writeContractAsync, isPending } = useScaffoldWriteContract({
  contractName: "HederaToken",
});

await writeContractAsync({
  functionName: "mint",
  args: [connectedAddress, parseEther("1")],
});
```

`HederaToken.mint` is `onlyOwner`. For HTS creation, `HtsTokenCreator.createToken` is payable (HTS fee via `msg.value`) and emits `TokenCreated`.

### UI

Use `@scaffold-hbar-ui/components` for web3 UI: `Address`, `AddressInput`, `Balance`, `EtherInput`, `IntegerInput`.

Use DaisyUI classes, not raw Tailwind when a DaisyUI component exists:

```tsx
<button className="btn btn-primary">Connect</button>
```

### Networks

- Hardhat: `packages/hardhat/hardhat.config.ts` (`hederaTestnet` 296, `hederaMainnet` 295)
- Foundry: `packages/foundry/foundry.toml` (`hedera_testnet`, `hedera_mainnet`)
- Next.js: `packages/nextjs/scaffold.config.ts` (target networks, polling, RPC overrides, WalletConnect)

## Style

| Style | Use |
| --- | --- |
| `UpperCamelCase` | types, components |
| `lowerCamelCase` | variables, functions |
| `CONSTANT_CASE` | constants |
| `snake_case` | Hardhat deploy files and Foundry scripts |

Next.js imports use the `~~` alias:

```tsx
import { useTargetNetwork } from "~~/hooks/scaffold-hbar";
```

App Router pages live under `packages/nextjs/app/`. Add `"use client"` when the page uses hooks.

Prefer `type` over `interface`. No `T` prefix on types. Let TypeScript infer when it can. Comments should add information.

Core package specifics: `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` are on — spread conditionally (`...(x ? { x } : {})`) instead of assigning `undefined`, and narrow array reads. Use `import type` for types (lint enforces it).

Commits follow Conventional Commits (`feat(core): …`, `fix(nextjs): …`, `docs: …`, `ci: …`) and are GPG-signed. Keep each commit green: tests, lint with `--max-warnings=0`, and type checks.

When writing prose (README, comments, docs), write `yarn <script>` only where a command is meant: the CLI rewrites that word to `npm run` in projects scaffolded with npm.
