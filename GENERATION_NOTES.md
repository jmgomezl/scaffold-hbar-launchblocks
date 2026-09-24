# Generation notes

## Repair attempt 3 (2026-09-24)

**What failed:** the `hts.burn` step from `.harness/runtime/context/prd.md` was
never added. The generator agent had exited with code 1 before writing any of
the required files, so every static assertion for the burn step, its op, test,
gallery flow and README row was missing, and `burn-flow-dry-run` failed because
`hts-launch-burn` did not exist anywhere in the gallery.

**What changed**, following AGENTS.md → "Adding a step type":

- `packages/launchblocks/src/hedera/ops/tokens.ts`: added `BurnParams`,
  `BurnResult`, `buildTokenBurn()` and `burnFungibleToken()`, mirroring
  `buildTokenMint`/`mintFungibleToken`.
- `packages/launchblocks/src/steps/hts/burn.ts`: new `htsBurn` step
  (`hts.burn`), registered in `packages/launchblocks/src/steps/index.ts`
  directly after `htsMint` (list and named exports).
- `packages/launchblocks/flows/hts-launch-burn.json`: new gallery flow
  (create token → burn 100,000 → open HCS log → record the burn), registered
  in `packages/launchblocks/src/gallery.ts` after the existing entries.
- Tests: `packages/launchblocks/test/steps/hts/burn.test.ts` (input
  validation + codegen), and a `buildTokenBurn()` case added to
  `packages/launchblocks/test/hedera/ops/tokens.test.ts`.
- `packages/launchblocks/src/harness/recipe.ts`: added `"hts.burn": 0.1` to
  `STEP_FEE_HBAR` (same cost class as mint). This changed the fee an
  *unlisted* step type resolves to in the existing
  `packages/launchblocks/test/harness/recipe.test.ts` "counts an unlisted
  step type at the default" case, which had used `hts.burn` as its example of
  an unregistered type — switched that test to `hts.wipe`, which is still
  genuinely unlisted.
- README.md: regenerated the step table with `yarn core:docs` (adds the
  `hts.burn` row) and added `hts-launch-burn` to the prose list of gallery
  flows under `packages/launchblocks/flows/`.

No changes under `packages/nextjs` — the Launch Studio, its APIs and the
generated `launch.ts` all discover steps through the registry, exactly as
AGENTS.md says they should.

**Verified:** `yarn core:test` (394/394 passing, including the existing
`test/steps/contract.test.ts` invariant check over every registered step),
`yarn core:lint --max-warnings=0`, `yarn core:check-types`, and
`yarn core:run hts-launch-burn --dry-run` (flow validates).
