import { PrivateKey } from "@hiero-ledger/sdk";
import type { Flow, FlowInput } from "@sh/launchblocks";
import { GALLERY, createDefaultRegistry } from "@sh/launchblocks";
import { vi } from "vitest";

const registry = createDefaultRegistry();

/** Settings the API reads from the environment; each test starts with none of them set. */
const SERVER_ENV = [
  "LAUNCHBLOCKS_ALLOW_MAINNET",
  "LAUNCHBLOCKS_RUN_TOKEN",
  "LAUNCHBLOCKS_RUNS_PER_HOUR",
  "LAUNCHBLOCKS_PUBLIC_DEMO",
  "LAUNCHBLOCKS_PUBLIC_HBAR_PER_HOUR",
  "LAUNCHBLOCKS_PUBLIC_MAX_HBAR_PER_STEP",
  "LAUNCHBLOCKS_ARTIFACTS_DIR",
  "HEDERA_NETWORK",
  "HEDERA_OPERATOR_ID",
  "HEDERA_OPERATOR_KEY",
  "HEDERA_OPERATOR_KEY_TYPE",
  "HEDERA_MIRROR_URL",
  "PYTH_API_KEY",
  "PYTH_HERMES_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "LAUNCHBLOCKS_ASSISTANT_MODEL",
  "LAUNCHBLOCKS_ASSISTANT_PER_HOUR",
  "LAUNCHBLOCKS_ASSISTANT_TOTAL_PER_HOUR",
];

export function clearServerEnv(): void {
  for (const name of SERVER_ENV) vi.stubEnv(name, undefined);
}

/** A throwaway operator: enough to build a context, never funded, never used on a network. */
export function stubOperator(network = "testnet"): void {
  vi.stubEnv("HEDERA_OPERATOR_ID", "0.0.1234");
  vi.stubEnv("HEDERA_OPERATOR_KEY", PrivateKey.generateECDSA().toStringRaw());
  vi.stubEnv("HEDERA_OPERATOR_KEY_TYPE", "ecdsa");
  vi.stubEnv("HEDERA_NETWORK", network);
}

/** The API keeps run counters and caches in module state, so each test loads its own copy. */
export async function fresh<T>(load: () => Promise<T>): Promise<T> {
  vi.resetModules();
  return load();
}

export function galleryInput(id = "hts-launch-basic"): FlowInput {
  const entry = GALLERY.find(candidate => candidate.id === id);
  if (!entry) throw new Error(`no gallery flow ${id}`);
  return structuredClone(entry.flow);
}

/** A flow document validated as the API validates it. */
export function validFlow(input: FlowInput): Flow {
  return registry.validateFlow(input);
}

export function galleryFlow(id = "hts-launch-basic"): Flow {
  return validFlow(galleryInput(id));
}

/** Sends value to a token the launch did not create: what a public demo must refuse. */
export const OUTSIDE_TRANSFER: FlowInput = {
  schemaVersion: 1,
  id: "outside-transfer",
  name: "Outside transfer",
  network: "testnet",
  steps: [{ id: "send", type: "hts.transfer", params: { tokenId: "0.0.15058", to: "0.0.98", amount: "1000" } }],
};

/** A POST as the reverse proxy forwards it, from the visitor at `ip`. */
export function post(url: string, body: unknown, headers: Record<string, string> = {}, ip = "203.0.113.7"): Request {
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": ip, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

export async function json(response: Response): Promise<{ status: number; body: any }> {
  return { status: response.status, body: await response.json() };
}
