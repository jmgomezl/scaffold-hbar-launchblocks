import { Inflate, deflateSync, strFromU8, strToU8 } from "fflate";
import { LaunchBlocksError } from "../errors";
import type { FlowInput } from "../flow/schema";

/**
 * A flow packed into a link: `/launch#flow=<JSON, deflated, base64url>`.
 * It lives in the URL fragment, which browsers never send to a server, so a
 * shared launch is stored nowhere but in the link itself.
 */
export const SHARE_FRAGMENT_KEY = "flow";

/** A link longer than this is not a flow the studio made; the gallery's largest is under 2,000 characters. */
export const MAX_SHARE_LINK_CHARS = 64 * 1024;
/** The run API's body limit: a larger flow could not run anyway. */
const MAX_FLOW_BYTES = 256 * 1024;
/** Deflate expands at most ~1,000×, so inflating this much at a time never holds more than ~1 MB. */
const INFLATE_SLICE = 1024;

export function encodeFlowForLink(flow: FlowInput): string {
  const packed = deflateSync(strToU8(JSON.stringify(flow)), { level: 9 });
  let binary = "";
  for (const byte of packed) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  if (encoded.length > MAX_SHARE_LINK_CHARS) {
    throw new LaunchBlocksError("SHARE_LINK_TOO_LARGE", "This flow is too large to share as a link", {
      hint: "Export the flow JSON and share the file instead.",
    });
  }
  return encoded;
}

/** Inflate a slice at a time and stop past `MAX_FLOW_BYTES`, so a crafted link cannot expand into gigabytes. */
function inflateCapped(packed: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  let size = 0;
  const inflater = new Inflate(chunk => {
    size += chunk.length;
    if (size > MAX_FLOW_BYTES) throw new Error("the flow is larger than any link should hold");
    parts.push(chunk);
  });
  for (let at = 0; at < packed.length; at += INFLATE_SLICE) {
    inflater.push(packed.subarray(at, at + INFLATE_SLICE), at + INFLATE_SLICE >= packed.length);
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

/** The flow a link carries. Only its shape is checked here; validate it like any other document. */
export function decodeFlowFromLink(encoded: string): FlowInput {
  try {
    if (encoded.length > MAX_SHARE_LINK_CHARS) throw new Error("longer than any flow's link");
    const binary = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
    const flow: unknown = JSON.parse(strFromU8(inflateCapped(Uint8Array.from(binary, char => char.charCodeAt(0)))));
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
