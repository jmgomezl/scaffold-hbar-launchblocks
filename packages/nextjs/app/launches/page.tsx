import Link from "next/link";
import { redirect } from "next/navigation";
import { FindLaunch } from "./_components/FindLaunch";
import { mirrorFromEnv } from "@sh/launchblocks";
import { getMetadata } from "~~/utils/scaffold-hbar/getMetadata";

export const metadata = getMetadata({
  title: "Launches",
  description:
    "Any LaunchBlocks launch, rebuilt from its HCS log: token, market, locked liquidity and schedules as they are now.",
  path: "/launches",
});

/** Real launches on testnet, one per kind of gallery flow. */
const TESTNET_EXAMPLES = [
  {
    topicId: "0.0.10674240",
    title: "Token with a SaucerSwap market",
    detail: "Pool opened at 0.0002 ℏ, then the first trade",
  },
  {
    topicId: "0.0.10676438",
    title: "Liquidity locked for 30 days",
    detail: "Every LP token held by a TokenLock contract",
  },
  { topicId: "0.0.10676532", title: "Scheduled reserve unlocks", detail: "Two mints the network runs by itself" },
  { topicId: "0.0.10716076", title: "Signed in HashPack", detail: "A visitor's own wallet paid for every step" },
];

type Props = { searchParams: Promise<{ topic?: string | string[] }> };

export default async function LaunchesPage({ searchParams }: Props) {
  const { topic } = await searchParams;
  if (typeof topic === "string" && topic.trim()) redirect(`/launches/${encodeURIComponent(topic.trim())}`);
  const { network } = mirrorFromEnv(process.env);

  return (
    <div className="mx-auto w-full max-w-5xl space-y-8 px-5 py-10">
      <section className="rounded-2xl bg-base-100 p-6 shadow-lg md:p-8">
        <h1 className="text-3xl font-bold">Launches</h1>
        <p className="mb-6 mt-3 max-w-3xl text-base-content/70">
          Every launch that opens an HCS topic writes what it creates there as it goes: the token, the pool, the lock,
          the schedules. A launch page reads that log back from the mirror node and shows each of them as it is now: the
          token&apos;s supply, the pool&apos;s price, what the lock still holds, which schedules have run. Nothing is
          stored by this app; the log is the record.
        </p>
        <FindLaunch />
      </section>

      {network === "testnet" && (
        <section aria-labelledby="examples-heading">
          <h2 id="examples-heading" className="mb-4 text-2xl font-bold">
            Real launches on testnet
          </h2>
          <div className="grid gap-4 md:grid-cols-2">
            {TESTNET_EXAMPLES.map(example => (
              <Link
                key={example.topicId}
                href={`/launches/${example.topicId}`}
                className="group rounded-2xl border border-base-300 bg-base-100 p-5 transition hover:border-primary hover:shadow-md"
              >
                <p className="font-semibold group-hover:text-primary">{example.title}</p>
                <p className="text-sm text-base-content/70">{example.detail}</p>
                <p className="mt-2 font-mono text-xs text-base-content/50">{example.topicId}</p>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
