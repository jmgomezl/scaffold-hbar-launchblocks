import { deflateSync } from "fflate";
import { describe, expect, it } from "vitest";
import { MAX_SHARE_LINK_CHARS, decodeFlowFromLink, encodeFlowForLink, studioLinkFor } from "../../src/editor/share";
import { galleryFlow } from "../../src/gallery";

describe("share links", () => {
  const flow = galleryFlow("hts-launch-locked-liquidity")!.flow;

  it("carry a flow in a URL fragment, compressed, and bring it back unchanged", () => {
    const link = studioLinkFor("https://launchblocks.example/", flow);
    expect(link).toMatch(/^https:\/\/launchblocks\.example\/launch#flow=[A-Za-z0-9_-]+$/);
    const encoded = link.split("#flow=")[1]!;
    expect(encoded.length).toBeLessThan(JSON.stringify(flow).length / 2);
    expect(decodeFlowFromLink(encoded)).toEqual(flow);
  });

  it("reject a link that was cut off or holds something else", () => {
    const encoded = encodeFlowForLink(flow);
    expect(() => decodeFlowFromLink(encoded.slice(0, 40))).toThrow(
      expect.objectContaining({ code: "SHARE_LINK_INVALID" }),
    );
    expect(() => decodeFlowFromLink("not-base64-at-all!")).toThrow(
      expect.objectContaining({ code: "SHARE_LINK_INVALID" }),
    );
  });

  it("stop inflating a crafted link long before it could exhaust memory", () => {
    // 8 MB of spaces deflates to about 8 KB: a short link that expands 30 times past the 256 KB cap.
    const bomb = deflateSync(new Uint8Array(8 * 1024 * 1024).fill(32), { level: 9 });
    const encoded = Buffer.from(bomb).toString("base64url");
    expect(encoded.length).toBeLessThan(MAX_SHARE_LINK_CHARS);
    expect(() => decodeFlowFromLink(encoded)).toThrow(expect.objectContaining({ code: "SHARE_LINK_INVALID" }));
    expect(() => decodeFlowFromLink("A".repeat(MAX_SHARE_LINK_CHARS + 1))).toThrow(
      expect.objectContaining({ code: "SHARE_LINK_INVALID" }),
    );
  });

  it("refuse to make a link too long to open", () => {
    const huge = { ...flow, description: undefined, steps: flow.steps.map(step => ({ ...step, label: undefined })) };
    const noise = Array.from({ length: 60_000 }, (_, index) => ((index * 7919) % 65_521).toString(36)).join("");
    expect(() => encodeFlowForLink({ ...huge, name: noise } as never)).toThrow(
      expect.objectContaining({ code: "SHARE_LINK_TOO_LARGE" }),
    );
  });
});
