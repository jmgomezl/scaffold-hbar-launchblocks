import htsLaunchBasic from "../flows/hts-launch-basic.json";
import htsLaunchLockedLiquidity from "../flows/hts-launch-locked-liquidity.json";
import htsLaunchSaucerSwap from "../flows/hts-launch-saucerswap.json";
import htsLaunchScheduledUnlocks from "../flows/hts-launch-scheduled-unlocks.json";
import type { FlowInput } from "./flow/schema";

export type GalleryEntry = {
  /** Matches the flow's `id`. */
  id: string;
  title: string;
  /** Why a developer would start from this flow. */
  blurb: string;
  flow: FlowInput;
};

/** Ready-to-run flows shipped with the template, in the order the UI lists them. */
export const GALLERY: readonly GalleryEntry[] = [
  {
    id: "hts-launch-saucerswap",
    title: "Token launch with a SaucerSwap market",
    blurb:
      "The full launchpad: create the token, log the launch on HCS, seed its first SaucerSwap V1 pool against HBAR, make the first trade to prove the market is live, and record it.",
    flow: htsLaunchSaucerSwap as FlowInput,
  },
  {
    id: "hts-launch-locked-liquidity",
    title: "Token launch with locked liquidity",
    blurb:
      "The launch with a lock: open the SaucerSwap market, deploy a TokenLock contract, move the pool's LP tokens into it for 30 days, read the lock back, and record it on HCS.",
    flow: htsLaunchLockedLiquidity as FlowInput,
  },
  {
    id: "hts-launch-scheduled-unlocks",
    title: "Token launch with scheduled unlocks",
    blurb:
      "Hold back part of the supply and schedule it to unlock in two tranches, at 30 and 60 days. The network mints each one on its date with nobody online.",
    flow: htsLaunchScheduledUnlocks as FlowInput,
  },
  {
    id: "hts-launch-basic",
    title: "HTS token launch with HCS log",
    blurb:
      "Fungible token with a fractional fee, finite supply and a public HCS launch log; mints a reserve and records it.",
    flow: htsLaunchBasic as FlowInput,
  },
];

export function galleryFlow(id: string): GalleryEntry | undefined {
  return GALLERY.find(entry => entry.id === id);
}
