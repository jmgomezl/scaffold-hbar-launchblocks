# Agent instructions

Briefing for coding agents in this app (Cursor, Claude Code, Codex). Claude Code loads it through `CLAUDE.md`.

This is **LaunchBlocks**, a Scaffold-HBAR template: a visual, block-based HTS token launchpad on Hedera. A launch is a *flow* (ordered JSON steps) that the app renders as Blockly blocks, runs from Next.js API routes with an operator key (or in the page, signed by a visitor's Hedera wallet), and exports as a `launch.ts` script that calls the core's operations. Next.js App Router, wallet connect, Debug Contracts, and Hedera networks (testnet, mainnet, local fork). Contracts use Hardhat.

Use the package manager this project was created with — see `packageManager` in the root `package.json`, or the lockfile. The command examples below are written for the package manager this copy was scaffolded with; run the same script names through whichever one the project uses.

## Packages

- `packages/launchblocks` (`@sh/launchblocks`) — framework-agnostic core: flow schema, step registry, runner, codegen, Hedera client factory. No React, no Next. Unit-tested with vitest.
- `packages/nextjs` — the frontend (App Router, RainbowKit, Wagmi, Viem, DaisyUI) plus the API routes that run flows. `test/api/` covers the routes and `services/launchblocks/server.ts` (run guards, public-demo policy, error statuses, streaming) with vitest, calling the handlers directly; `e2e/` drives the Launch Studio in Chromium with Playwright. `services/launchblocks/assistant.ts` is the studio's AI companion (`app/api/launchblocks/assistant`, the Assistant tab): it only advises, and what it knows about blocks comes from the step registry, so a new step needs nothing there; product-level changes (a new signer, a new policy) belong in its `GUIDE`.
- `packages/hardhat` — Hardhat (`hardhat-deploy`): the starter's contracts plus `TokenLock`, which the Deploy contract block deploys from the compiled artifacts.

Product rules that shape every change:

1. **Flows are JSON, the editor is optional.** Anything the block editor can do must work from a flow JSON file through the runner and the API. Never put logic in the editor that the runner does not have.
2. **No general-purpose blocks.** No if/loop/variable blocks. Every block is exactly one step type in the registry.
3. **One hero use case.** The HTS launch → SaucerSwap pool flow is the headline; other steps and gallery flows are "also included".
4. **Never log or return an operator key.** `HederaContext` holds it; nothing serializes it.
5. **Every step works with a wallet too.** A wallet context has `hedera.signer` and no `operatorKey`. Send transactions through `send`, `submit`, `sendContract` or, for an operator that needs the record, `sendWithRecord` (`hedera/ops/submit.ts`), never `execute` directly (the one exception is `ContractCreateFlow`, several transactions in one), and when `hedera.signer` is set, read from the mirror node (`hedera/mirror.ts`) instead of paid queries such as `TokenInfoQuery`: the wallet would have to approve each one.

## Commands

Package-prefixed scripts for package-specific work. Keep only truly cross-workspace commands unprefixed.

```bash
# Local chain + deploy + frontend (separate terminals)
yarn hardhat:chain    # Hedera-forked Hardhat node on 8545
yarn workspace @sh/hardhat deploy --network localhost
yarn next:start       # http://localhost:3000 (next:start and next:dev both run the dev server; next:serve serves a build)

# Frontend only
yarn next:dev

# Quality / build
yarn lint             # next + hardhat + core
yarn check-types      # next + hardhat + core
yarn test             # core + API (vitest) + hardhat
yarn format
yarn next:build
yarn hardhat:compile

# Core package only
yarn core:test
yarn core:test:coverage
yarn core:lint
yarn core:check-types
yarn core:harness <flow.json>   # export a flow as a Hedera Harness recipe into .harness/
yarn core:check <flow>          # validate a flow and list its steps; sends nothing
yarn core:run <flow>            # run a flow on testnet (spends HBAR)
yarn core:doctor                # check the operator before spending anything
yarn core:mcp                   # the MCP server on stdio (clients run node packages/launchblocks/bin/mcp.cjs)

# API routes and the studio in a browser
yarn next:test
yarn next:e2e          # after next:build and, once, next:e2e:install; no operator, nothing is spent

# Live networks
yarn workspace @sh/hardhat deploy --network hederaTestnet   # or hederaMainnet
yarn hardhat:verify:testnet

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
  registry/   types.ts (StepDefinition contract), define-step.ts, registry.ts (createRegistry, validateFlow),
              unknown-keys.ts (params a step does not take), catalog.ts (the step catalog the editor, API and MCP serve)
  runner/     runner.ts (runFlow → RunResult with per-step records, links, events; preflightFlow),
              public-policy.ts (what a public demo lets anonymous visitors run)
  codegen/    typescript.ts (generateLaunchScript, renderExpr)
  contracts/  artifacts.ts (loadHardhatArtifact: ABI and bytecode from packages/hardhat/artifacts; node only)
  harness/    recipe.ts (generateHarnessRecipe: a flow → a Hedera Harness recipe; STEP_FEE_HBAR cost table)
  hedera/     context.ts (HederaContext, hashscanUrl), client.ts (createHederaContext, hederaContextFromEnv),
              wallet.ts (walletHederaContext: a connected wallet signs), mirror.ts (mirror node reads),
              ops/submit.ts (send, submit, sendContract: operator or wallet; sendWithRecord: operator), errors.ts (translate statuses and wallet refusals)
  saucerswap/ config.ts (deployments), pool.ts, swap.ts: the SaucerSwap V1 operations
  pyth/       config.ts (Pyth's Hedera contract, feed ids), hermes.ts (signed updates, API key), price.ts (priceInUsd)
  steps/      one folder per namespace (hts/, hcs/, hss/, pyth/, saucerswap/, contract/), one file per step type
  launches/   read.ts (readLaunch: a launch rebuilt from its HCS log, plus its token, pool, lock and schedules now)
  mcp/        server.ts (createLaunchBlocksMcpServer: the MCP tools); scripts/mcp.ts runs it on stdio, bin/mcp.cjs starts it
  docs/       steps-table.ts (the README's step table, generated from the registry)
  gallery.ts  the example flows; their JSON lives in flows/
  errors.ts   LaunchBlocksError subclasses with stable `code`s
  browser.ts  the entry for wallet runs in the page (no Node built-ins); editor/ is the editor's entry,
              including editor/share.ts (a flow packed into a `/launch#flow=` link)
flows/        the gallery's flow documents
scripts/      run-flow.ts (core:run and core:check), doctor.ts (core:doctor), docs.ts (core:docs), harness-recipe.ts (core:harness), mcp.ts
test/         mirrors src/; test/helpers/fake-steps.ts has network-free steps for runner/registry tests
```

**Launch logs and launch pages.** A flow that opens an HCS topic and writes JSON events to it (`{ "event": "token.launched", "tokenId": … }`) gets a public page at `/launches/<topic id>` (`packages/nextjs/app/launches/`), built by `readLaunch`. It recognises `token.launched`, `market.opened` (`pairId`, `openingPriceHbar`, `poolUrl`), `liquidity.locked` (`lock`, `lpTokenId`, `releaseTime`) and any `{ "schedule": id, "at": … }` object. Other events and fields still show in the timeline, with ids linked to HashScan by their key's name. So a new step that should appear on the page only needs its flow to log it in that shape.

**MCP server.** Its tools (`list_steps`, `get_step`, `list_examples`, `get_example`, `validate_flow`, `generate_script`, `share_link`, `run_flow`, `read_launch`) call the same core functions as the studio and `core:run`: add capability in the core, not in a tool. `run_flow` dry-runs unless `dryRun: false`. stdout is the protocol, so nothing may print there (scripts/mcp.ts sends console output to stderr), and clients start it with `node packages/launchblocks/bin/mcp.cjs`, never through a package manager, which prints its own output. Tests: `test/mcp/server.test.ts`, including one over real stdio.

A **flow** is `{ schemaVersion: 1, id, name, network, steps: [{ id, type, params }] }`. Step ids are camelCase and become variable names in generated code. Params may reference earlier outputs with `{{steps.<id>.<key>}}` — a whole-string reference keeps the output's type; inside longer strings it interpolates.

A **step definition** (`defineStep({...})`) bundles, in one object:

| Field | Purpose |
| --- | --- |
| `type` | `namespace.action`, e.g. `hts.createToken` |
| `input` / `output` | zod schemas; `input` is parsed after references resolve |
| `outputExample` | a complete, realistic output — used to type-check wiring before running and as the docs example |
| `ui` | label, category, colour, `fields` (param → editor field; `advanced: true` folds a rarely changed one behind the block's "more settings" box) and `outputs` (what later steps may reference) |
| `docs` | one-line summary, markdown details, Hedera services and integrations touched |
| `execute(input, ctx)` | calls the step's operation (the SDK work lives in `src/hedera/ops/` or the integration's module); throw a `LaunchBlocksError` with a `hint` for user-fixable failures |
| `preflight(params, ctx)` | optional: checks what the step will need before the flow's first step runs (Deploy contract checks its artifact is compiled). Dry runs call it too, so `ctx` has the network and artifacts but no Hedera client |
| `checkWiring(params, earlier)` | optional: checks against the earlier steps a param references, as written in the flow (Mint tokens refuses an amount more precise than the token the flow creates, and a token created without a supply key) |
| `codegen(ctx)` | body of an async function that does the same with the SDK and `return`s the outputs; use `ctx.expr(key)` for params (`ctx.expr(key, { data: true })` for free-form data such as a message) and `ctx.addImport()` for imports |

Validation also reports any param the `input` schema does not know, at any depth: nested params are objects (`"keys": { "admin": false }`), never dotted keys.

#### Adding a step type

Model a new step on **Mint tokens**: `mintFungibleToken` in `src/hedera/ops/tokens.ts` and `src/steps/hts/mint.ts`.

1. Write the operation in `packages/launchblocks/src/hedera/ops/<area>.ts` (or the integration's module, like `src/saucerswap/`) and export it through that folder's `index.ts`, so a generated `launch.ts` can import it. Send transactions through `send`, `submit` or `sendContract` (rule 5), and give it a `build…` function that returns the unsent transaction, for tests. Steps and operations also run in the page for wallet runs, so they use no Node built-ins (`fs`, `path`, `dotenv`); `test/editor/browser-safe.test.ts` fails on any.
2. Create `packages/launchblocks/src/steps/<namespace>/<action>.ts` exporting `defineStep({...})`: `execute` calls the operation, and `codegen` is `ctx => callOperation(ctx, "<operation>", [<param keys>])` from `steps/shared.ts`. Reuse the field kinds in `registry/types.ts` (`tokenId`, `accountId`, `topicId`, `amount`, …): kinds drive which earlier outputs the editor offers to an input. Entity ids, `amount` and `value` are sockets; a `value` socket takes any output, for generic inputs like contract arguments.
3. Register it in `packages/launchblocks/src/steps/index.ts`, in `BUILT_IN_STEPS` and the named exports.
4. Test it without a network: in `test/steps/<namespace>.test.ts` (or a file of its own, `test/steps/<namespace>/<action>.test.ts`, as the Harness recipe asks), parse `input` and `outputExample` and assert the `codegen` body, as the `hts.createToken codegen` and `hts.mint codegen` tests do; in `test/hedera/ops/<area>.test.ts`, check the `build…` transaction. If the step reads anything back, cover the wallet path as `test/hedera/wallet.test.ts` does. Every registered step is also checked by the invariants in `test/steps/built-in-steps.test.ts`.
5. If it produces on-chain entities, list them in `ui.outputs` with the right kind so the runner emits HashScan links.
6. If its network fee is not small, add it to `STEP_FEE_HBAR` in `src/harness/recipe.ts`: exported recipes fund on-chain checks from that table, the public-run policy budgets with it, and unlisted types count as 2 ℏ.
7. Optionally, add a gallery flow: `packages/launchblocks/flows/<id>.json` and an entry at the end of `GALLERY` in `src/gallery.ts`. Tests check that every gallery flow passes the public-run policy and that its exported `launch.ts` type-checks.
8. Regenerate the README's step table with `yarn core:docs` (CI runs `yarn core:docs:check`).
9. Run `yarn core:test && yarn core:lint && yarn core:check-types` (lint fails on warnings too).

The editor and API discover steps through the registry; there is nothing to register in `packages/nextjs` as long as the step uses an existing `ui.category` (`hts`, `hcs`, `hss`, `saucerswap`, `oracle`, `contract`). A new category takes three edits: `StepCategory` in `src/registry/types.ts`, `CATEGORY_COLOUR` in `src/steps/shared.ts`, and the toolbox title in `CATEGORY_NAMES` (`packages/nextjs/app/launch/_lib/blocks.ts`). A new Hedera service also needs a `HederaService` value in `src/registry/types.ts`.

`.harness/` holds a hedera-harness recipe that exercises exactly this recipe (adding `hts.burn`). Its `prd.md` is a worked example of the change.

`yarn core:harness <flow.json>` (or **Export → Harness recipe** in the studio) turns any flow into a recipe of its own, `.harness/<flow-id>.spec.yaml` plus `.harness/<flow-id>/`, that asks an agent to add the flow to the gallery unchanged. Keep each spec directly in `.harness/`: the harness takes the spec's parent directory as the project root.

### Hardhat

- Contracts: `packages/hardhat/contracts/`
- Deploy scripts: `packages/hardhat/deploy/`
- Tests: `packages/hardhat/test/`
- Config: `packages/hardhat/hardhat.config.ts`
- Tagged deploy: if `deployHederaToken.tags = ["HederaToken"]`, run `yarn workspace @sh/hardhat deploy --tags HederaToken`

### After deploy

`yarn hardhat:deploy` writes ABIs and addresses to `packages/nextjs/contracts/deployedContracts.ts`, which Debug Contracts uses. Put third-party contracts in `packages/nextjs/contracts/externalContracts.ts`.

The **Deploy contract** block does not use either file: it deploys from the compiled artifacts in `packages/hardhat/artifacts`. To make a new contract deployable from a flow, add its `.sol` file to `packages/hardhat/contracts/`, run `yarn hardhat:compile`, and put its name in the block.

Contracts on this starter: `HederaToken` (ERC-20), `HtsTokenCreator` (HTS precompile at `0x167`) and `TokenLock` (holds a token, such as a pool's LP tokens, until a release time).

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

Use `@scaffold-hbar-ui/components` for web3 UI: `Address`, `Balance`, `HederaAddress`, `HederaAddressInput`, `HbarInput`, `BaseInput`, `HederaPortalFaucet`.

Use DaisyUI classes, not raw Tailwind when a DaisyUI component exists:

```tsx
<button className="btn btn-primary">Connect</button>
```

### Networks

- Hardhat: `packages/hardhat/hardhat.config.ts` (`hederaTestnet` 296, `hederaMainnet` 295)
- Next.js: `packages/nextjs/scaffold.config.ts` (target networks, polling, RPC overrides, WalletConnect)

## Style

| Style | Use |
| --- | --- |
| `UpperCamelCase` | types, components |
| `lowerCamelCase` | variables, functions |
| `CONSTANT_CASE` | constants |
| `snake_case` | Hardhat deploy files |

Next.js imports use the `~~` alias:

```tsx
import { useTargetNetwork } from "~~/hooks/scaffold-hbar";
```

App Router pages live under `packages/nextjs/app/`. Add `"use client"` when the page uses hooks.

Prefer `type` over `interface`. No `T` prefix on types. Let TypeScript infer when it can. Comments should add information.

Core package specifics: `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` are on — spread conditionally (`...(x ? { x } : {})`) instead of assigning `undefined`, and narrow array reads. Use `import type` for types (lint enforces it).

Commits follow Conventional Commits (`feat(core): …`, `fix(nextjs): …`, `docs: …`, `ci: …`); the template's own repository also signs them with GPG, which a project made from it need not do. Keep each commit green: tests, lint (a warning fails it), and type checks.

When writing prose (README, comments, docs), write `yarn <script>` only where a command is meant: the CLI rewrites that word to `npm run` in projects scaffolded with npm.
