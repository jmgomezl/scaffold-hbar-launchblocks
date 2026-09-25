import { cache } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { FindLaunch } from "../_components/FindLaunch";
import { LaunchView } from "../_components/LaunchView";
import type { LaunchRecord } from "@sh/launchblocks";
import { LaunchBlocksError, mirrorFromEnv, readLaunch } from "@sh/launchblocks";
import type { Metadata } from "next";
import { getMetadata } from "~~/utils/scaffold-hbar/getMetadata";

// The pool's price and the schedules change, but not by the second: a page is rebuilt at most every 20 s,
// which spares the mirror node the 5 to 8 reads a view costs.
export const revalidate = 20;
export const runtime = "nodejs";

/** None at build time: each launch page is built on its first visit, then cached for `revalidate`. */
export async function generateStaticParams() {
  return [];
}

type Props = { params: Promise<{ topicId: string }> };

/** One mirror node read per request, shared by the page and its metadata. */
const load = cache(async (topicId: string) => {
  try {
    return { launch: await readLaunch(mirrorFromEnv(process.env), topicId) };
  } catch (error) {
    if (error instanceof LaunchBlocksError)
      return { error: { code: error.code, message: error.message, hint: error.hint } };
    throw error;
  }
});

/** Only what this launch has: "token, market and schedules". */
function contents(launch: LaunchRecord): string {
  const parts = [
    launch.token && "token",
    launch.pool && "market",
    launch.lock && "locked liquidity",
    launch.schedules.length && "schedules",
  ].filter((part): part is string => typeof part === "string");
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : (parts[0] ?? "log");
}

const isMissing = (code: string) => code === "LAUNCH_NOT_FOUND" || code === "ENTITY_ID_INVALID";

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const topicId = decodeURIComponent((await params).topicId);
  const result = await load(topicId);
  if (result.error && isMissing(result.error.code)) return { title: "Launch not found", robots: { index: false } };
  const launch = result.launch;
  const token = launch?.token;
  return getMetadata({
    title: token ? `${token.name} (${token.symbol}) launch` : `Launch log ${topicId}`,
    description: launch
      ? `${token ? `The ${token.symbol} launch` : "A launch"} on Hedera ${launch.network}, rebuilt from its HCS log: its ${contents(launch)} as they are now.`
      : "A Hedera token launch, rebuilt from its HCS log.",
    path: `/launches/${topicId}`,
  });
}

export default async function LaunchLogPage({ params }: Props) {
  const topicId = decodeURIComponent((await params).topicId);
  const result = await load(topicId);
  if (result.launch) return <LaunchView launch={result.launch} />;
  if (isMissing(result.error.code)) notFound();
  // The mirror node failed or answered something unexpected: say so, and let the reader try again.
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 px-5 py-12">
      <div className="alert alert-warning alert-soft flex-col items-start">
        <p className="font-semibold">{result.error.message}</p>
        {result.error.hint && <p className="text-sm">{result.error.hint}</p>}
      </div>
      <FindLaunch />
      <p className="text-sm">
        <Link href="/launches" className="link link-primary">
          See example launches
        </Link>
      </p>
    </div>
  );
}
