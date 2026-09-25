import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PrivateKey } from "@hiero-ledger/sdk";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { decodeFlowFromLink } from "../../src/editor/share";
import { galleryFlow } from "../../src/gallery";
import { MIRROR_BASE_URL, createHederaContext } from "../../src/hedera/client";
import type { LaunchBlocksMcpOptions } from "../../src/mcp/server";
import { createLaunchBlocksMcpServer } from "../../src/mcp/server";

afterEach(() => vi.restoreAllMocks());

const MIRROR = { network: "testnet" as const, mirrorBaseUrl: MIRROR_BASE_URL.testnet };
const basic = () => structuredClone(galleryFlow("hts-launch-basic")!.flow);

async function connect(options: Partial<LaunchBlocksMcpOptions> = {}) {
  const server = createLaunchBlocksMcpServer({ studioUrl: "https://studio.example", mirror: MIRROR, ...options });
  const client = new Client({ name: "test", version: "0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: { type: string; text: string }[];
    };
    const text = result.content[0]?.text ?? "";
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {
      // generate_script answers with the script itself.
    }
    // Tool results are free-form JSON; each test asserts the shape it expects.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { isError: result.isError === true, data: data as any };
  };
  return { client, call };
}

describe("the LaunchBlocks MCP server", () => {
  it("tells an agent how to work and lists its nine tools", async () => {
    const { client } = await connect();
    expect(client.getInstructions()).toMatch(/validate_flow until ok/);
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name)).toEqual([
      "list_steps",
      "get_step",
      "list_examples",
      "get_example",
      "validate_flow",
      "generate_script",
      "share_link",
      "run_flow",
      "read_launch",
    ]);
    expect(tools.find(tool => tool.name === "run_flow")?.annotations).toMatchObject({ destructiveHint: true });
  });

  it("describes the steps and examples an agent builds from", async () => {
    const { call } = await connect();
    const steps = await call("list_steps");
    expect(steps.data).toContainEqual(
      expect.objectContaining({ type: "saucerswap.createPool", services: ["HTS", "SmartContract", "MirrorNode"] }),
    );
    // Nested params show as the objects they are, so an agent never writes "keys.admin".
    const createToken = steps.data.find((entry: { type: string }) => entry.type === "hts.createToken");
    expect(createToken.params).toContainEqual(
      expect.objectContaining({
        key: "keys",
        kind: "object",
        fields: expect.arrayContaining([expect.objectContaining({ key: "admin" })]),
      }),
    );
    expect(JSON.stringify(steps.data)).not.toContain('"keys.admin"');
    const step = await call("get_step", { type: "hts.createToken" });
    expect(step.data.inputSchema).toMatchObject({ type: "object" });
    expect((await call("get_step", { type: "hts.nope" })).data).toMatchObject({ code: "STEP_UNKNOWN" });

    const examples = await call("list_examples");
    expect(examples.data.map((entry: { id: string }) => entry.id)).toContain("hts-launch-basic");
    expect((await call("get_example", { id: "hts-launch-basic" })).data).toEqual(basic());
  });

  it("validates a flow, with its cost when it is valid and every issue when it is not", async () => {
    const { call } = await connect();
    const valid = await call("validate_flow", { flow: basic() });
    expect(valid.data).toMatchObject({ ok: true, issues: [], estimate: { perRunHbar: expect.any(Number) } });

    const flow = basic();
    (flow.steps[0]!.params as Record<string, unknown>).decimals = 40;
    const invalid = await call("validate_flow", { flow });
    expect(invalid).toMatchObject({ isError: false, data: { ok: false } });
    expect(invalid.data.issues).toEqual([
      expect.objectContaining({ stepId: "createToken", path: expect.stringContaining("decimals") }),
    ]);

    // A flow sent as JSON text works the same; text that is not JSON gets a code to act on.
    expect((await call("validate_flow", { flow: JSON.stringify(basic()) })).data).toMatchObject({ ok: true });
    expect(await call("validate_flow", { flow: "{ not json" })).toMatchObject({
      isError: true,
      data: { code: "FLOW_JSON_INVALID" },
    });
  });

  it("exports launch.ts and a studio link that carries the flow", async () => {
    const { call } = await connect();
    const script = await call("generate_script", { flow: basic() });
    expect(script.data).toContain("Generated through the LaunchBlocks MCP server.");
    expect(script.data).toMatch(/await createFungibleToken\(ctx/);

    const { data } = await call("share_link", { flow: basic() });
    expect(data.link).toMatch(/^https:\/\/studio\.example\/launch#flow=/);
    expect(decodeFlowFromLink(data.link.split("#flow=")[1])).toMatchObject({ id: "hts-launch-basic" });
  });

  it("dry-runs by default, and only runs for real with an operator, off mainnet", async () => {
    const { call } = await connect();
    const dry = await call("run_flow", { flow: basic() });
    expect(dry.data).toMatchObject({ dryRun: true, network: "testnet", canRun: false, steps: expect.any(Array) });
    expect(dry.data.steps).toHaveLength(5);
    // A dry run makes the checks a real run makes first, such as a contract that was never compiled.
    const missing = {
      schemaVersion: 1,
      id: "missing-contract",
      name: "Missing contract",
      steps: [{ id: "deploy", type: "contract.deploy", params: { contract: "NoSuchContract" } }],
    };
    expect((await call("run_flow", { flow: missing })).isError).toBe(true);
    expect(await call("run_flow", { flow: basic(), dryRun: false })).toMatchObject({
      isError: true,
      data: { code: "OPERATOR_MISSING" },
    });

    const operator = vi.fn(() =>
      createHederaContext({
        network: "mainnet",
        operatorId: "0.0.1234",
        operatorKey: PrivateKey.generateECDSA().toStringRaw(),
        operatorKeyType: "ecdsa",
      }),
    );
    const withOperator = await connect({ operator });
    expect((await withOperator.call("run_flow", { flow: { ...basic(), network: "mainnet" } })).data).toMatchObject({
      dryRun: true,
      canRun: false,
    });
    expect(
      await withOperator.call("run_flow", { flow: { ...basic(), network: "mainnet" }, dryRun: false }),
    ).toMatchObject({
      isError: true,
      data: { code: "MAINNET_DISABLED" },
    });
    expect(operator).not.toHaveBeenCalled();
  });

  it("reads a launch from its HCS log, with the page to share", async () => {
    const message = Buffer.from(JSON.stringify({ event: "token.launched", tokenId: "0.0.501" })).toString("base64");
    vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      const url = String(input);
      const body = url.includes("/messages")
        ? {
            messages: [{ sequence_number: 1, consensus_timestamp: "1790000000.1", message, payer_account_id: "0.0.7" }],
          }
        : url.includes("/topics/")
          ? { topic_id: "0.0.500", memo: "LBD launch log", created_timestamp: "1790000000.0" }
          : null;
      return body
        ? new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
        : new Response("{}", { status: 404 });
    });
    const { call } = await connect();
    const { data } = await call("read_launch", { topicId: "0.0.500" });
    expect(data).toMatchObject({
      page: "https://studio.example/launches/0.0.500",
      memo: "LBD launch log",
      token: null,
    });
    expect(data.entries).toHaveLength(1);
  });

  it("starts over stdio from bin/mcp.cjs, printing nothing but the protocol", async () => {
    const client = new Client({ name: "test", version: "0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve(__dirname, "../../bin/mcp.cjs")],
      // No operator for this test, whatever packages/nextjs/.env holds: dotenv never overrides a set variable.
      env: { ...(process.env as Record<string, string>), HEDERA_OPERATOR_ID: "" },
      stderr: "pipe",
    });
    await client.connect(transport);
    try {
      expect((await client.listTools()).tools).toHaveLength(9);
      const result = (await client.callTool({ name: "run_flow", arguments: { flow: basic() } })) as {
        content: { text: string }[];
      };
      expect(JSON.parse(result.content[0]!.text)).toMatchObject({ dryRun: true, canRun: false });
    } finally {
      await client.close();
    }
  }, 60_000);
});
