# Hedera Harness recipe: add `hts.burn`

This directory is a [hedera-harness](https://github.com/hedera-dev/hedera-harness)
recipe. It asks a coding agent to extend LaunchBlocks with a **Burn tokens**
step by following `AGENTS.md`, then decides for itself whether the agent
succeeded.

| File | Tier | What it checks |
| --- | --- | --- |
| `prd.md` | — | What to build: the operation, step, tests, gallery flow, and docs. |
| `validators/static.json` | 0 | Files exist where AGENTS.md puts them, the step and flow are registered, the README table lists `hts.burn`, and there are no `.env` files. |
| `validators/yarn.json` | 1 | Core tests, lint, strict types, the README docs check, a **dry run of the new flow**, app lint, and the production build. |
| `validators/playwright-smoke.yaml` | 2 | The app boots; `/`, `/launch` and the step and gallery APIs render. |
| `acceptance-contract.json` | 3 | The new block is in the studio toolbox, its example loads as valid, the API describes it, and export generates the call. |
| `spec.yaml` → `chainValidation` | 3.5 | The new flow runs **on testnet** as the harness's funded ephemeral account and burns supply. |

## Running it

Use a fresh scaffold, or move your own `packages/nextjs/.env` aside first. The
harness forbids env files in the workspace, and it checks the disk, not git.
Export the operator in your shell instead:

```bash
export HEDERA_OPERATOR_ID=0.0.xxxxx
export HEDERA_OPERATOR_KEY=<ECDSA private key>
yarn harness:doctor     # prerequisites, the recipe, every path it references
yarn harness:validate   # Tiers 0–1 only, no agent; fails until hts.burn exists
yarn harness:run        # the full run: agent, repairs, all tiers
```

- **The recipe assumes the template's default package manager, Yarn.** That
  matches the hedera-harness pilot. create-scaffold-hbar deliberately leaves
  `.harness/` untouched when it converts a project to npm.
- **Tier 3.5 needs an ECDSA operator**, because it provisions an EVM-aliased
  account. It funds that account with 45 ℏ and sweeps back what is left.
- **Tiers 2 and 3 need Playwright:** `yarn add -D playwright` and
  `npx playwright install chromium`. The agent (`claude` by default) must be on
  your `PATH`.

## How the recipe was verified

A validator is only useful if it fails without the feature and passes with it.
Both were checked with `yarn harness:validate` (Tiers 0–2), in a clean copy of
the template with no env files:

- **Without `hts.burn`** (the template as shipped): `passed=false` with 15
  findings, all about the missing step: its files, registration, operation,
  tests, gallery entry and README row, plus the new flow's dry run. Every
  existing gate passed, and there were no false alarms from the forbidden-file
  or secret checks.
- **With a correct implementation that follows `prd.md`**: `passed=true`,
  `findings=0`, including the Playwright gate over `/`, `/launch` and the step
  and gallery APIs.
- **Tier 3.5**: the exact `deploy` command from `spec.yaml`, run with the
  signer variables set, burned 100,000 of 1,000,000 tokens on testnet. The
  mirror node shows token `0.0.10674620` with a total supply of 900,000, and
  its HCS log records the burn.

The Tier 3 acceptance contract needs a full agent run to grade, and has not been
graded yet.

## Why the on-chain check uses a deploy hook

Hedera Harness hands its ephemeral account to the browser as a burner wallet,
and to `chainValidation.deploy` commands as `HARNESS_SIGNER_*` environment
variables. LaunchBlocks does not sign with a browser wallet; its flows are
signed on the server by an operator. So the deploy hook runs
`yarn core:run hts-launch-burn` with the ephemeral account set as that
operator. The key only ever lives in the process environment, and the runner
exits non-zero if any step fails.
