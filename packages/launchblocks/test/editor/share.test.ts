import { describe, expect, it } from "vitest";
import { decodeFlowFromLink, encodeFlowForLink, studioLinkFor } from "../../src/editor/share";
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
});
