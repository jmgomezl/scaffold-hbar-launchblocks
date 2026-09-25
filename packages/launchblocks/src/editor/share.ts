import { deflateSync, inflateSync, strFromU8, strToU8 } from "fflate";
import { LaunchBlocksError } from "../errors";
import type { FlowInput } from "../flow/schema";

/**
 * A flow packed into a link: `/launch#flow=<JSON, deflated, base64url>`.
 * It lives in the URL fragment, which browsers never send to a server, so a
 * shared launch is stored nowhere but in the link itself.
 */
export const SHARE_FRAGMENT_KEY = "flow";

export function encodeFlowForLink(flow: FlowInput): string {
  const packed = deflateSync(strToU8(JSON.stringify(flow)), { level: 9 });
  let binary = "";
  for (const byte of packed) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The flow a link carries. Only its shape is checked here; validate it like any other document. */
export function decodeFlowFromLink(encoded: string): FlowInput {
  try {
    const binary = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
    const flow: unknown = JSON.parse(strFromU8(inflateSync(Uint8Array.from(binary, char => char.charCodeAt(0)))));
    if (flow && typeof flow === "object" && Array.isArray((flow as { steps?: unknown }).steps))
      return flow as FlowInput;
  } catch {
    // Reported below: a truncated or edited link fails the same way as a wrong one.
  }
  throw new LaunchBlocksError("SHARE_LINK_INVALID", "This link does not hold a LaunchBlocks flow", {
    hint: "It may have been cut off when it was copied. Ask for the full link.",
  });
}

/** The studio URL that opens `flow`, e.g. `https://example.org/launch#flow=…`. */
export function studioLinkFor(baseUrl: string, flow: FlowInput): string {
  return `${baseUrl.replace(/\/+$/, "")}/launch#${SHARE_FRAGMENT_KEY}=${encodeFlowForLink(flow)}`;
}
