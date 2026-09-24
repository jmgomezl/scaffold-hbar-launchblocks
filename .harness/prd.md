# Add an `hts.burn` step to LaunchBlocks

## Product brief

LaunchBlocks composes Hedera token launches from blocks. A launch often mints a
reserve and later **burns** part of the supply, which is a public, verifiable
commitment that circulating supply went down. The template can create, mint,
transfer and airdrop tokens, but it cannot burn them.

Add a **Burn tokens** step (`hts.burn`) and a gallery example that uses it.
The step must appear in the Launch Studio toolbox, the step API, the CLI and
the generated README, **without any frontend changes**. That is the point of
the template's step registry, and part of what this recipe checks.

Follow **AGENTS.md → "Adding a step type"**. It describes exactly this change.

## Who it is for

- Token teams who want "launch, then burn the unsold reserve" as one flow.
- Developers checking that the template extends the way AGENTS.md says it does.

## What to build

### 1. The operation — `packages/launchblocks/src/hedera/ops/tokens.ts`

Next to `mintFungibleToken`, and in the same style:

- `export function buildTokenBurn(params: BurnParams, decimals: number): TokenBurnTransaction`.
  A pure builder: token id, plus the amount converted from whole tokens to
  smallest units with the existing `toUnits`/`toLong` helpers.
- `export async function burnFungibleToken(hedera, params: BurnParams): Promise<BurnResult>`.
  It reads the token's decimals with `getTokenInfo`, submits with the existing
  `submit` helper, and returns:
  `{ tokenId, transactionId, burnedUnits, newTotalSupplyUnits, newTotalSupply }`,
  where `newTotalSupply` is a human amount formatted with `fromUnits`.
- `BurnParams = { tokenId: string; amount: DecimalAmount }`.

Burning takes tokens from the treasury (the operator) and needs the token's
**supply key**. `TOKEN_HAS_NO_SUPPLY_KEY` already has a hint in `STATUS_HINTS`;
do not duplicate it.

### 2. The step — `packages/launchblocks/src/steps/hts/burn.ts`

Export `htsBurn = defineStep({ ... })` with:

| Field | Value |
| --- | --- |
| `type` | `hts.burn` |
| input | `tokenId` (`TokenIdSchema`), `amount` (`PositiveAmountSchema`, whole tokens) |
| output | `tokenId`, `transactionId`, `burnedUnits`, `newTotalSupplyUnits`, `newTotalSupply` (all strings) |
| `ui.label` | `Burn tokens` |
| `ui.category` | `hts`, using the HTS category colour |
| `ui.fields` | `tokenId` (kind `tokenId`), `amount` (kind `amount`) |
| `ui.outputs` | `transactionId` (kind `transactionId`), `newTotalSupply` (kind `amount`) |
| `docs.summary` | one line saying it burns supply from the treasury and needs the supply key |
| `docs.hederaServices` | `["HTS"]` |
| `execute` | `burnFungibleToken(ctx.hedera, input)` |
| `codegen` | `callOperation(ctx, "burnFungibleToken", ["tokenId", "amount"])` |

Register it in `packages/launchblocks/src/steps/index.ts`: put it in
`BUILT_IN_STEPS` directly after `htsMint`, and in the named exports.

### 3. Tests — no network

- `packages/launchblocks/test/steps/hts/burn.test.ts`. The input rejects a zero
  or negative amount and a malformed token id; the codegen body calls
  `burnFungibleToken` with `tokenId` and `amount`.
- In `packages/launchblocks/test/hedera/ops/tokens.test.ts`, a `buildTokenBurn()`
  test showing the amount is scaled by the token's decimals.

The existing invariant test (`test/steps/built-in-steps.test.ts`) already
checks every registered step, so the new step must pass it unchanged.

### 4. The gallery example — `packages/launchblocks/flows/hts-launch-burn.json`

A flow with `id` `hts-launch-burn` and `name` `Token launch with a supply burn`,
on testnet, with these steps in order:

1. `createToken` (`hts.createToken`). Symbol `LBB`, 8 decimals, initial supply
   `1000000`, infinite supply, keys `admin` and **`supply`** enabled.
2. `burnReserve` (`hts.burn`). Token `{{steps.createToken.tokenId}}`, amount `100000`.
3. `createLog` (`hcs.createTopic`). Memo `{{steps.createToken.symbol}} burn log`.
4. `recordBurn` (`hcs.submitMessage`). Topic `{{steps.createLog.topicId}}`, a JSON
   message `{ "event": "supply.burned", "tokenId": …, "burned": "100000",
   "newTotalSupply": "{{steps.burnReserve.newTotalSupply}}",
   "burnTx": "{{steps.burnReserve.transactionId}}" }`.

Register it in `packages/launchblocks/src/gallery.ts`, **at the end of**
`GALLERY`, with the title `Token launch with a supply burn` and a one-line blurb.

### 5. Docs

Run `yarn core:docs` so the README step table includes `hts.burn`. CI fails
when it is stale.

## Constraints

- **No changes under `packages/nextjs`.** The studio and API discover steps
  through the registry. If it seems to need a frontend change, the step
  definition is wrong.
- Do not change the behaviour of existing steps, flows or tests.
- Unit tests never touch the network.
- Keep `yarn core:lint --max-warnings=0`, `yarn core:check-types`,
  `yarn next:lint --max-warnings=0` and `yarn next:build` clean.
- Never create `.env` files. The harness supplies the operator through the
  environment.

## Done when

- `yarn core:run hts-launch-burn --dry-run` validates the new flow.
- The Launch Studio toolbox shows **Burn tokens** under **Tokens · HTS**, and the
  new example loads as valid.
- On testnet, the flow burns 100,000 tokens from the new token, leaving a total
  supply of 900,000, and records the burn on its HCS log.
