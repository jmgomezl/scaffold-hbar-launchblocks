import { SHARE_FRAGMENT_KEY, decodeFlowFromLink, studioLinkFor } from "@sh/launchblocks/editor";
import type { FlowInput } from "@sh/launchblocks/editor";

/** A link that opens `flow` in this studio. The flow rides in the fragment, so no server ever stores it. */
export function shareLinkFor(flow: FlowInput): string {
  return studioLinkFor(window.location.origin, flow);
}

/** The flow a `#flow=` link carries, or null when the URL has none. Throws SHARE_LINK_INVALID for a cut-off link. */
export function sharedFlowInUrl(): FlowInput | null {
  const encoded = new URLSearchParams(window.location.hash.slice(1)).get(SHARE_FRAGMENT_KEY);
  return encoded ? decodeFlowFromLink(encoded) : null;
}

/** Drop the fragment once its flow is open, so a reload shows the user's edits rather than the link again. */
export function clearSharedFlowFromUrl(): void {
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
}
