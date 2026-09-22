import htsLaunchBasic from "../flows/hts-launch-basic.json";
import htsLaunchSaucerSwap from "../flows/hts-launch-saucerswap.json";
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
