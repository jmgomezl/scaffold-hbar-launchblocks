import { describe, expect, it } from "vitest";

import {
  decodeAddress,
  decodeUint,
  encodeAddress,
  encodeCall,
  encodeUint,
  entityIdToEvmAddress,
  evmAddressToEntityId,
} from "../../src/hedera/abi";

describe("encodeAddress()", () => {
  it("left-pads a 20-byte address to a word", () => {
    expect(encodeAddress("0x0000000000000000000000000000000000003ad2")).toBe(
      "0000000000000000000000000000000000000000000000000000000000003ad2",
    );
  });

  it("rejects anything that is not 20 bytes of hex", () => {
    expect(() => encodeAddress("0x1234")).toThrow(/20-byte/);
    expect(() => encodeAddress("0xzz00000000000000000000000000000000003ad2")).toThrow(/20-byte/);
  });
});

describe("encodeUint()", () => {
  it("encodes values beyond Number range", () => {
    expect(encodeUint(2n ** 64n)).toBe("0000000000000000000000000000000000000000000000010000000000000000");
    expect(encodeUint(0)).toBe("0".repeat(64));
  });

  it("rejects negatives", () => {
    expect(() => encodeUint(-1)).toThrow(/negative/);
  });
});

describe("encodeCall()", () => {
  it("concatenates the selector and arguments", () => {
    expect(encodeCall("0xe6a43905", encodeUint(1), encodeUint(2))).toBe(
      "0xe6a43905" + "0".repeat(63) + "1" + "0".repeat(63) + "2",
    );
  });

  it("rejects a malformed selector", () => {
    expect(() => encodeCall("0xe6a439")).toThrow(/4-byte selector/);
  });
});

describe("decoders", () => {
  it("decode uints and addresses by word index", () => {
    const data = `0x${"0".repeat(63)}5${"fe7cc3ceb7b1128bfc3889184e2d5561bf74bfb3".padStart(64, "0")}`;
    expect(decodeUint(data, 0)).toBe(5n);
    expect(decodeAddress(data, 1)).toBe("0xfe7cc3ceb7b1128bfc3889184e2d5561bf74bfb3");
  });

  it("report a missing word rather than returning garbage", () => {
    expect(() => decodeUint("0x", 0)).toThrow(/no word at index 0/);
    expect(() => decodeAddress(`0x${"0".repeat(64)}`, 1)).toThrow(/no word at index 1/);
  });
});

describe("entity id conversion", () => {
  it("round-trips long-zero addresses", () => {
    expect(evmAddressToEntityId(entityIdToEvmAddress("0.0.19264"))).toBe("0.0.19264");
  });

  it("rejects malformed entity ids", () => {
    expect(() => entityIdToEvmAddress("19264")).toThrow(/shard\.realm\.num/);
  });

  it("refuses to guess an entity id for an aliased CREATE2 address", () => {
    expect(() => evmAddressToEntityId("0xfe7cc3ceb7b1128bfc3889184e2d5561bf74bfb3")).toThrow(/aliased/);
  });
});
