import Link from "next/link";
import { CopyCommand } from "./_components/home/CopyCommand";
import { LaunchIllustration } from "./_components/home/LaunchIllustration";
import { GALLERY } from "@sh/launchblocks/editor";
import type { NextPage } from "next";
import {
  ArrowTopRightOnSquareIcon,
  CheckBadgeIcon,
  CodeBracketIcon,
  CubeTransparentIcon,
  PlayIcon,
  RocketLaunchIcon,
} from "@heroicons/react/24/outline";

const REPO = "https://github.com/jmgomezl/scaffold-hbar-launchblocks";
const SCAFFOLD_COMMAND = "npm create scaffold-hbar@latest -- --template jmgomezl/scaffold-hbar-launchblocks";
const HASHSCAN = "https://hashscan.io/testnet";

/** One run of the hero flow, started from the Launch Studio; every id is also on its HCS log. */
const PROOF = [
  { what: "Token LBM (1,000,000 supply)", id: "0.0.10674237", href: `${HASHSCAN}/token/0.0.10674237` },
  { what: "HCS launch log", id: "0.0.10674240", href: `${HASHSCAN}/topic/0.0.10674240` },
  {
    what: "SaucerSwap pool, opening at exactly 0.0002 ℏ",
    id: "0.0.10674241",
    href: `${HASHSCAN}/contract/0.0.10674241`,
  },
  {
    what: "First trade: 1 ℏ → 4,533.05 LBM, filled at the quote",
    id: "0.0.7231440-1790127891-895373365",
    href: `${HASHSCAN}/transaction/0.0.7231440-1790127891-895373365`,
  },
];

const STEPS = [
  {
    Icon: CubeTransparentIcon,
    title: "Compose",
    body: "Snap steps together. Sockets take a typed value or an output of an earlier step, dragged from the Outputs drawer.",
  },
  {
    Icon: CheckBadgeIcon,
    title: "Check",
    body: "Every param and every reference is validated against the step schemas before a single HBAR is spent.",
  },
  {
    Icon: PlayIcon,
    title: "Run",
    body: "Steps execute on testnet in order. Each block turns green as its transaction reaches consensus, with HashScan links.",
  },
  {
    Icon: CodeBracketIcon,
    title: "Export",
    body: "Download the flow as JSON for the CLI, or as a standalone launch.ts that calls the same functions.",
  },
];

const UNDER_THE_HOOD = [
  {
    name: "Token Service",
    body: "Fungible tokens with configurable keys, finite or infinite supply, fractional and HBAR custom fees, mints, transfers and HIP-904 airdrops.",
  },
  { name: "Consensus Service", body: "A public, ordered, timestamped log per launch, in text or JSON." },
  {
    name: "SaucerSwap",
    body: "The token's first pool with an exact opening price, then a first trade quoted by the router itself.",
  },
  {
    name: "Schedule Service",
    body: "Vesting transfers and supply unlocks as long-term schedules, which the network runs on their date with nobody online.",
  },
  {
    name: "Smart contracts",
    body: "Deploy and call your own Hardhat contracts from blocks, such as a TokenLock that holds the pool's LP tokens for 30 days.",
  },
  {
    name: "Mirror node",
    body: "Free quotes, pool and contract reads, EVM-alias resolution, exchange rates, and reading the launch log back.",
  },
];

/** What `.harness/` grades after the agent adds `hts.burn`; kept in step with `.harness/README.md`. */
const HARNESS_TIERS = [
  {
    tier: "0–1",
    body: "The step, its tests and a new example sit where AGENTS.md puts them; tests, lint, strict types, a dry run of the new flow and the production build pass.",
  },
  { tier: "2", body: "The app boots, and its pages and the step and gallery APIs render." },
  {
    tier: "3",
    body: "Burn tokens is in the studio toolbox, its example loads as valid, and export generates the call.",
  },
  {
    tier: "3.5",
    body: "The new flow burns supply on testnet, signed by the harness's own funded throwaway account.",
  },
];

const Home: NextPage = () => {
  return (
    <div className="flex grow flex-col">
      <section className="hedera-gradient w-full px-5 py-14 text-white dark:bg-none dark:bg-hedera-charcoal lg:py-20">
        <div className="mx-auto grid max-w-6xl items-center gap-10 lg:grid-cols-[1.1fr_1fr]">
          <div>
            <p className="mb-3 text-sm font-medium uppercase tracking-widest text-white/70">Scaffold-HBAR template</p>
            <h1 className="mb-5 text-4xl font-bold leading-tight md:text-5xl">
              Launch a token. Give it a market. Block by block.
            </h1>
            <p className="mb-8 max-w-xl text-lg text-white/85">
              LaunchBlocks turns a Hedera token launch into blocks you snap together: create an HTS token, open a public
              HCS log, seed a SaucerSwap pool and make the first trade. Then it runs the launch on testnet and shows
              every transaction as it lands.
            </p>
            <div className="flex flex-wrap gap-3">
              <Link href="/launch" className="btn btn-lg border-none bg-white text-hedera-violet hover:bg-white/90">
                <RocketLaunchIcon className="h-5 w-5" />
                Open Launch Studio
              </Link>
              <a
                href={REPO}
                target="_blank"
                rel="noreferrer"
                className="btn btn-lg btn-outline border-white/60 text-white hover:border-white hover:bg-white/10"
              >
                View on GitHub
              </a>
            </div>
          </div>
          <div className="flex justify-center lg:justify-end">
            <LaunchIllustration />
          </div>
        </div>
      </section>

      <div className="mx-auto w-full max-w-6xl space-y-16 px-5 py-14">
        <section aria-labelledby="proof-heading" className="rounded-2xl bg-base-100 p-6 shadow-lg md:p-8">
          <div className="mb-5 flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="proof-heading" className="text-2xl font-bold">
              Verified on testnet
            </h2>
            <p className="text-sm opacity-70">One run of the full launch. Every id is also recorded on its HCS log.</p>
          </div>
          <ul className="divide-y divide-base-300">
            {PROOF.map(item => (
              <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <span>{item.what}</span>
                <a
                  href={item.href}
                  target="_blank"
                  rel="noreferrer"
                  className="link link-primary inline-flex items-center gap-1 break-all font-mono text-sm"
                >
                  {item.id}
                  <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5 shrink-0" />
                </a>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="examples-heading">
          <h2 id="examples-heading" className="mb-2 text-2xl font-bold">
            Start from an example
          </h2>
          <p className="mb-6 opacity-70">Each opens in the Launch Studio, ready to edit, validate and run.</p>
          <div className={`grid gap-5 md:grid-cols-2 ${GALLERY.length % 3 === 0 ? "lg:grid-cols-3" : ""}`}>
            {GALLERY.map(entry => (
              <Link
                key={entry.id}
                href={`/launch?example=${entry.id}`}
                className="group flex flex-col rounded-2xl border border-base-300 bg-base-100 p-6 shadow-sm transition hover:border-primary hover:shadow-md"
              >
                <h3 className="mb-2 text-lg font-semibold">{entry.title}</h3>
                <p className="mb-4 grow text-sm opacity-75">{entry.blurb}</p>
                <div className="mb-4 flex flex-wrap gap-1.5">
                  {entry.flow.steps.map(step => (
                    <span key={step.id} className="badge badge-ghost badge-sm font-mono">
                      {step.type}
                    </span>
                  ))}
                </div>
                <span className="text-sm font-medium text-primary group-hover:underline">Open in studio →</span>
              </Link>
            ))}
          </div>
        </section>

        <section aria-labelledby="how-heading">
          <h2 id="how-heading" className="mb-6 text-2xl font-bold">
            How it works
          </h2>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map(({ Icon, title, body }) => (
              <div key={title} className="rounded-2xl bg-base-100 p-6 shadow-sm">
                <div className="hedera-gradient mb-4 flex h-11 w-11 items-center justify-center rounded-full">
                  <Icon className="h-5 w-5 text-white" />
                </div>
                <h3 className="mb-1 font-semibold">{title}</h3>
                <p className="text-sm opacity-75">{body}</p>
              </div>
            ))}
          </div>
        </section>

        <section aria-labelledby="hood-heading" className="grid gap-8 lg:grid-cols-[1fr_1.2fr]">
          <div>
            <h2 id="hood-heading" className="mb-3 text-2xl font-bold">
              Under the hood
            </h2>
            <p className="mb-4 opacity-75">
              Creating a pool and trading against it takes a few SDK calls. Getting them right took measurements on
              testnet: the LP recipient must be the account&apos;s EVM alias, the pool is created in two calls so the
              opening price comes out exact, and the documented gas is too low.
            </p>
            <a
              href={`${REPO}#the-saucerswap-integration`}
              target="_blank"
              rel="noreferrer"
              className="link link-primary inline-flex items-center gap-1 text-sm"
            >
              Read how the SaucerSwap integration works
              <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" />
            </a>
          </div>
          <dl className="grid gap-4 sm:grid-cols-2">
            {UNDER_THE_HOOD.map(item => (
              <div key={item.name} className="rounded-2xl border border-base-300 p-5">
                <dt className="mb-1 font-semibold">{item.name}</dt>
                <dd className="text-sm opacity-75">{item.body}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section aria-labelledby="template-heading" className="rounded-2xl bg-base-100 p-6 shadow-lg md:p-8">
          <h2 id="template-heading" className="mb-2 text-2xl font-bold">
            Make it your starting point
          </h2>
          <p className="mb-5 opacity-75">
            Scaffold your own copy, add a testnet operator, and launch. New step types slot into the registry and appear
            here with no frontend changes.
          </p>
          <CopyCommand command={SCAFFOLD_COMMAND} />
          <a
            href={`${REPO}#quick-start`}
            target="_blank"
            rel="noreferrer"
            className="link link-primary mt-4 inline-flex items-center gap-1 text-sm"
          >
            Quick start and cost of a launch
            <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" />
          </a>
        </section>

        <section aria-labelledby="harness-heading" className="grid gap-8 lg:grid-cols-[1fr_1.2fr]">
          <div>
            <p className="mb-2 text-sm font-medium uppercase tracking-widest text-primary">Hedera Harness</p>
            <h2 id="harness-heading" className="mb-3 text-2xl font-bold">
              Let an agent add the next block
            </h2>
            <p className="mb-4 opacity-75">
              The template ships a Hedera Harness recipe. It asks a coding agent to add a Burn tokens step by following
              AGENTS.md, then grades the work itself, up to burning real supply on testnet. The checks were tried both
              ways: 15 findings on the template as shipped, none on a correct implementation. Any launch you build can
              become a recipe of its own: in the studio, choose Export, then Harness recipe.
            </p>
            <CopyCommand command="yarn harness:run" />
            <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-sm">
              <a
                href={`${REPO}/tree/main/.harness`}
                target="_blank"
                rel="noreferrer"
                className="link link-primary inline-flex items-center gap-1"
              >
                The recipe and how it was verified
                <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" />
              </a>
              <a
                href={`${REPO}/blob/main/.harness/prd.md`}
                target="_blank"
                rel="noreferrer"
                className="link link-primary inline-flex items-center gap-1"
              >
                What the agent is asked to build
                <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" />
              </a>
            </div>
          </div>
          <ol className="grid gap-4 sm:grid-cols-2">
            {HARNESS_TIERS.map(item => (
              <li key={item.tier} className="rounded-2xl border border-base-300 p-5">
                <span className="badge badge-primary badge-outline mb-2 font-mono">Tier {item.tier}</span>
                <p className="text-sm opacity-75">{item.body}</p>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </div>
  );
};

export default Home;
