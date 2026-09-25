import { cache } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { FindLaunch } from "../_components/FindLaunch";
import { LaunchView } from "../_components/LaunchView";
import { LaunchBlocksError, mirrorFromEnv, readLaunch } from "@sh/launchblocks";
import type { Metadata } from "next";
import { getMetadata } from "~~/utils/scaffold-hbar/getMetadata";

// Read on every visit: the pool's price and the schedules change.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const topicId = decodeURIComponent((await params).topicId);
  const { launch } = await load(topicId);
  const token = launch?.token;
  return getMetadata({
    title: token ? `${token.name} (${token.symbol}) launch` : `Launch log ${topicId}`,
    description: token
      ? `The ${token.symbol} launch on Hedera ${launch.network}, rebuilt from its HCS log: token, market, locks and schedules as they are now.`
      : "A Hedera token launch, rebuilt from its HCS log.",
  });
}

export default async function LaunchLogPage({ params }: Props) {
  const topicId = decodeURIComponent((await params).topicId);
  const result = await load(topicId);
  if (result.launch) return <LaunchView launch={result.launch} />;
  if (result.error.code === "LAUNCH_NOT_FOUND" || result.error.code === "ENTITY_ID_INVALID") notFound();
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
