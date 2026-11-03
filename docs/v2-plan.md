# LaunchBlocks v2: a token launch that runs itself

After Run, the network carries out the rest of the launch on its own schedule: the liquidity lock
releases itself, vesting tranches pay out, and every event lands on the HCS launch log. No keeper
bot, no server, no cron. Contracts book their own future calls through the Hedera Schedule Service
(HIP-1215), and prices come from a feed that works on Hedera today (Chainlink, with Pyth as fallback).

Why: the Scaffold-HBAR bounty winners were keeperless (HIP-1215), contracts-first, focused, and used
working oracles. v1 had none of the first, a stale-only Pyth price, an SDK core, and too much breadth.

Status: `[ ]` todo · `[~]` in progress · `[x]` done.

## Verified facts this plan relies on

- Schedule Service system contract at `0x16b`, HIP-1215 functions in hiero-ledger/hiero-contracts
  `contracts/schedule-service/IHRC1215.sol`: `scheduleCall(to, expirySecond, gasLimit, value, callData)`
  returns `(int64 responseCode, address schedule)`; `hasScheduleCapacity(expirySecond, gasLimit)`;
  `deleteSchedule(schedule)`. Codes: `22` SUCCESS, `306` too far in future, `307` must be in the
  future, `370` that second is busy (`contracts/common/HederaResponseCodes.sol`).
- The scheduling contract pays for the scheduled execution, so it must hold HBAR.
- A schedule can be at most `scheduling.maxExpirationFutureSeconds` ahead (62 days by default), so
  longer waits chain hops.
- Chainlink HBAR/USD on Hedera testnet: `0x59bC155EB6c6C415fE43255aF66EcF0523c92B4a`, 8 decimals,
  read on-chain on 2026-10-22 (description "HBAR / USD", updated minutes earlier).

## M1 · Keeperless contracts (HIP-1215)

- [x] **T1 Schedule Service interface and a test double.** Our own minimal `IHederaScheduleService`
  (the HIP-1215 functions we use), and `MockHederaScheduleService` that tests install at `0x16b`
  with `hardhat_setCode`: it records each scheduled call, can mark seconds busy, and lets a test fire
  a call the way the network would at its expiry.
- [x] **T2 `SelfReleasingLock`.** v1's `TokenLock` that books its own `release` at the release time,
  chaining hops for locks longer than the network allows, moving to the next free second when one
  is busy, and keeping a manual `release` as a fallback. Funded with a little HBAR for the scheduled
  execution; whatever is left goes back to the funder after release. No owner, nothing changes after
  deployment. Tests: short lock, long lock (hops), busy second, early call refused, fallback,
  refund, failed scheduling.
- [x] **T3 `VestingSchedule`.** Tranches paid to a beneficiary; each payment books the next.
  Same scheduling helper as T2 (extract a shared base contract).
- [~] **T4 Testnet proof.** Deploy both with minute-scale intervals, watch the network run them,
  record HashScan links in the README. First run (lock 0.0.11130385): the network ran schedule
  0.0.11130407 at its expiry second, paid by the contract, so HIP-1215 works; the release reverted
  with `INVALID_ALIAS_KEY` because the script passed the long-zero address of an ECDSA alias account
  (fixed: ids now go through the core's `toEvmAddress`). `arm()` needs ~1.5M gas. Deploying through
  ContractCreateFlow cost ~23 ℏ per contract (ContractCreate's base fee plus file storage), so the
  core now deploys as an Ethereum transaction (gas only; mirror estimates 0.92M / 0.97M gas, about
  1 ℏ each). Booking through `0x16b` costs 1,409,649 gas whether the booked run has 750k or 3M
  (two testnet schedules), so a 2M-gas run can book the next one. Rerun with
  `scripts/prove-self-scheduling.ts`, which goes through the T7 operations.

## M2 · A price that works

- [x] **T6 Price step.** `oracle.priceInUsd`, "Price in USD (Chainlink)": Chainlink's HBAR/USD feed on
  Hedera first (push oracle, free read; default Max age = the 24 h heartbeat plus an hour), Pyth's
  on-chain price as cross-check (must agree within 1%) and as fallback when Chainlink is stale. Same
  Tokens/HBAR outputs; `hts-launch-usd-price` uses it; `pyth.priceInUsd` stays for older flows. Read
  live on testnet: $0.07975153, 426 s old. Studio, home page, assistant, README and AGENTS updated.
- [ ] **T5 On-chain `PriceGuard`** (later: only when a contract needs a price itself, such as a
  scheduled buyback). Chainlink `AggregatorV3` with the same staleness and deviation rules, in Solidity.

## M3 · Studio and launch pages

- [x] **T7 Steps.** `hss.selfReleasingLock` ("Lock tokens, released by the network") and `hss.vesting`
  ("Vest tokens, paid by the network"): deploy, arm, fund through `hedera/ops/self-scheduling.ts`;
  HBAR for the runs defaults to what the schedule needs (0.2 per payout, 1.7 per booking); codegen,
  fee estimate, public-run policy (treasury beneficiary, launch's own token, at most 5 ℏ parked),
  README step table, tests. Wallet runs work but deploy through ContractCreate (several approvals,
  ~23 ℏ); T13 decides the wallet path.
- [x] **Cheaper deploy.** `deployContract` sends an Ethereum transaction signed with the operator's
  ECDSA key when the account is its alias (no ContractCreate fee, no file storage), sized from the
  mirror's gas estimate, one at a time per operator, retrying a taken nonce once, and checking the
  contract's token slots. Admin key, memo or initcode over 5 KB keep ContractCreate.
- [ ] **T8 Gallery flow.** "Token launch that runs itself": token, HCS log, SaucerSwap pool at a
  Chainlink USD price, LP into a self-releasing lock, team tokens into vesting, all logged.
- [ ] **T9 Launch page.** Show the upcoming scheduled calls with countdowns, and the ones the network
  already ran (mirror node), next to the HCS timeline.

## M4 · Focus

- [ ] **T10** AI assistant off by default (opt-in with `OPENAI_API_KEY`), out of the hero path.
- [ ] **T11** Trim the README to under 5,000 words: *Look at it first (no wallet, no .env)*,
  *What you sign and what it costs*, *What you get that is hard to build alone*, *What this template
  does not do*, *Pitfalls we measured*.
- [ ] **T12** A free "look first" path (open a verified launch, nothing spent) and a cheap path
  (self-scheduled vesting without creating a pool).

## M5 · Ship

- [ ] **T13** Wallet as the default signer for real use; the app account stays for the free demo.
- [ ] **T14** CI: contract tests on the Hedera fork, fresh scaffold with npm and yarn, gate checks.
- [ ] **T15** Testnet proofs table, Harness recipe for the new flow, release, and a new demo video.
