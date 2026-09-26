import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearServerEnv, fresh, galleryInput, json, post, stubOperator } from "~~/test/helpers";

const loadAssistant = () => fresh(() => import("~~/app/api/launchblocks/assistant/route"));
const TEST_KEY = "sk-test-not-a-real-key";

beforeEach(() => clearServerEnv());
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** OpenAI's streaming format: one `data:` line per chunk of text, then [DONE]. */
function openAiStream(...texts: string[]): Response {
  const lines = texts.map(text => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
  return new Response([...lines, "data: [DONE]\n\n"].join(""), { headers: { "content-type": "text/event-stream" } });
}

/** Stand in for the provider; the returned spy holds each request it got. */
function provider(response: () => Response) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => response());
}

/** The NDJSON events of an answer. */
async function events(response: Response) {
  return (await response.text())
    .trim()
    .split("\n")
    .map(line => JSON.parse(line) as { type: string; text?: string; error?: { code: string } });
}

describe("the Launch Studio assistant", () => {
  it("says whether it is set up, and never shows the key", async () => {
    let route = await loadAssistant();
    expect((await json(await route.GET())).body).toEqual({ enabled: false, model: null });
    const refused = await json(await route.POST(post("/api/launchblocks/assistant", { question: "Hi" })));
    expect(refused).toMatchObject({ status: 503, body: { error: { code: "ASSISTANT_DISABLED" } } });

    vi.stubEnv("OPENAI_API_KEY", TEST_KEY);
    route = await loadAssistant();
    const status = await json(await route.GET());
    expect(status.body).toEqual({ enabled: true, model: "gpt-5.4-mini" });
    expect(JSON.stringify(status.body)).not.toContain(TEST_KEY);
  });

  it("answers from what it knows about LaunchBlocks and the launch on screen, streaming the text", async () => {
    vi.stubEnv("OPENAI_API_KEY", TEST_KEY);
    stubOperator();
    const operatorKey = process.env.HEDERA_OPERATOR_KEY as string;
    const fetch = provider(() => openAiStream("Seed the pool ", "after the token."));
    const flow = galleryInput("hts-launch-saucerswap");
    const route = await loadAssistant();
    const response = await route.POST(
      post("/api/launchblocks/assistant", {
        question: "What does the pool step do?",
        history: [
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi! Ask me anything." },
        ],
        flow,
        focus: { stepId: "seedPool" },
        runError: { code: "POOL_EXISTS", message: "A pool already exists", stepId: "seedPool" },
      }),
    );
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    expect(await events(response)).toEqual([
      { type: "text", text: "Seed the pool " },
      { type: "text", text: "after the token." },
      { type: "done" },
    ]);

    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${TEST_KEY}`);
    const body = JSON.parse(String(init.body)) as {
      model: string;
      stream: boolean;
      reasoning_effort: string;
      messages: { role: string; content: string }[];
    };
    expect(body).toMatchObject({ model: "gpt-5.4-mini", stream: true, reasoning_effort: "low" });
    const [system, ...rest] = body.messages;
    // The guide and every block's docs, from the registry.
    expect(system?.role).toBe("system");
    expect(system?.content).toContain("You are the LaunchBlocks companion");
    expect(system?.content).toContain("## Seed SaucerSwap pool (`saucerswap.createPool`)");
    expect(system?.content).toContain("INSUFFICIENT_PAYER_BALANCE");
    // The conversation so far, then the launch on screen with its cost, the error and the block in question.
    expect(rest.map(message => message.role)).toEqual(["user", "assistant", "user"]);
    const question = rest.at(-1)?.content ?? "";
    expect(question).toContain('"id": "hts-launch-saucerswap"');
    expect(question).toMatch(/<cost>About [\d.]+ ℏ in all/);
    expect(question).toContain("<problems>none</problems>");
    expect(question).toContain("<run_error>step seedPool: POOL_EXISTS: A pool already exists</run_error>");
    expect(question).toContain('a "Seed SaucerSwap pool" block (saucerswap.createPool)');
    expect(question).toMatch(/Question: What does the pool step do\?$/);
    // No secret of the server's reaches the provider, other than its own key in the header.
    expect(String(init.body)).not.toContain(operatorKey);
    expect(String(init.body)).not.toContain(TEST_KEY);
  });

  it("lists the launch's problems as the studio sees them", async () => {
    vi.stubEnv("OPENAI_API_KEY", TEST_KEY);
    const fetch = provider(() => openAiStream("Fix the symbol."));
    const flow = galleryInput();
    (flow.steps[0]!.params as Record<string, unknown>).symbol = "";
    const route = await loadAssistant();
    await (
      await route.POST(post("/api/launchblocks/assistant", { question: "Why?", flow, detachedStepIds: ["spare"] }))
    ).text();
    const body = JSON.parse(String((fetch.mock.calls[0] as [string, RequestInit])[1].body)) as {
      messages: { content: string }[];
    };
    const question = body.messages.at(-1)?.content ?? "";
    expect(question).toContain("createToken steps[0].params.symbol");
    expect(question).toContain("spare: outside the Launch block, so it will not run");
    expect(question).not.toContain("<cost>");
  });

  it("refuses what could spend the credit for nothing: other sites, bad bodies, and too many questions", async () => {
    vi.stubEnv("OPENAI_API_KEY", TEST_KEY);
    vi.stubEnv("LAUNCHBLOCKS_ASSISTANT_PER_HOUR", "2");
    provider(() => openAiStream("ok"));
    const route = await loadAssistant();
    const ask = (ip = "203.0.113.7", headers: Record<string, string> = {}) =>
      route.POST(post("/api/launchblocks/assistant", { question: "Hi" }, headers, ip));

    expect((await ask("203.0.113.7", { "sec-fetch-site": "cross-site" })).status).toBe(403);
    const long = await json(await route.POST(post("/api/launchblocks/assistant", { question: "x".repeat(2001) })));
    expect(long).toMatchObject({ status: 400, body: { error: { code: "QUESTION_INVALID" } } });
    const badTurn = await json(
      await route.POST(
        post("/api/launchblocks/assistant", { question: "Hi", history: [{ role: "system", content: "x" }] }),
      ),
    );
    expect(badTurn.body.error.issues).toEqual([expect.objectContaining({ path: "history.0" })]);

    expect((await ask()).status).toBe(200);
    expect((await ask()).status).toBe(200);
    expect(await json(await ask())).toMatchObject({ status: 429, body: { error: { code: "ASSISTANT_RATE_LIMITED" } } });
    // Another visitor still gets answers.
    expect((await ask("198.51.100.9")).status).toBe(200);
  });

  it("turns a refused key or a missing model into a code and a hint, never the provider's own text", async () => {
    vi.stubEnv("OPENAI_API_KEY", TEST_KEY);
    const route = await loadAssistant();
    provider(
      () =>
        new Response(JSON.stringify({ error: { message: `Incorrect API key provided: ${TEST_KEY}` } }), {
          status: 401,
        }),
    );
    const refused = await events(await route.POST(post("/api/launchblocks/assistant", { question: "Hi" })));
    expect(refused).toEqual([{ type: "error", error: expect.objectContaining({ code: "ASSISTANT_KEY_REJECTED" }) }]);
    expect(JSON.stringify(refused)).not.toContain(TEST_KEY);

    vi.restoreAllMocks();
    provider(() => new Response("{}", { status: 404 }));
    const missing = await events(await route.POST(post("/api/launchblocks/assistant", { question: "Hi" })));
    expect(missing[0]?.error?.code).toBe("ASSISTANT_MODEL_UNAVAILABLE");
  });

  it("uses the model and OpenAI-compatible endpoint the deployment picks, without OpenAI-only fields", async () => {
    vi.stubEnv("OPENAI_API_KEY", TEST_KEY);
    vi.stubEnv("LAUNCHBLOCKS_ASSISTANT_MODEL", "gpt-4.1-mini");
    vi.stubEnv("OPENAI_BASE_URL", "https://llm.example/v1/");
    const fetch = provider(() => openAiStream("ok"));
    const route = await loadAssistant();
    await (await route.POST(post("/api/launchblocks/assistant", { question: "Hi" }))).text();
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://llm.example/v1/chat/completions");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.model).toBe("gpt-4.1-mini");
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body).not.toHaveProperty("store");
  });
});
