import htsLaunchBasic from "../flows/hts-launch-basic.json";
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
