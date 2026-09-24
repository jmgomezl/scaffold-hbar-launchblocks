"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DAppConnector } from "@hashgraph/hedera-wallet-connect/dist/lib/dapp";
import type { ExtensionData } from "@hashgraph/hedera-wallet-connect/dist/lib/shared";
import type { Signer } from "@hiero-ledger/sdk";
import scaffoldConfig from "~~/scaffold.config";

/**
 * A Hedera wallet (HashPack, Kabila, Blade, …) connected through
 * hedera-wallet-connect, for visitors who want to sign runs with their own
 * testnet account instead of the demo account.
 *
 * The connector and WalletConnect are loaded on first use only, so the studio
 * stays light for everyone who keeps the default. Only the dApp half of the
 * library is imported: its root entry also pulls in the wallet-side SDK.
 */

export type WalletExtension = Pick<ExtensionData, "id" | "name" | "icon">;

export type WalletState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; extensions: WalletExtension[] }
  | { status: "connecting"; extensions: WalletExtension[] }
  | { status: "connected"; accountId: string; extensions: WalletExtension[] }
  | { status: "error"; message: string; extensions: WalletExtension[] };

let connectorPromise: Promise<DAppConnector> | null = null;

async function loadConnector(): Promise<DAppConnector> {
  connectorPromise ??= (async () => {
    const [{ DAppConnector }, shared, { LedgerId }] = await Promise.all([
      import("@hashgraph/hedera-wallet-connect/dist/lib/dapp"),
      import("@hashgraph/hedera-wallet-connect/dist/lib/shared"),
      import("@hiero-ledger/sdk"),
    ]);
    const origin = window.location.origin;
    const connector = new DAppConnector(
      {
        name: "LaunchBlocks",
        description: "A visual token launchpad on Hedera, built with Scaffold-HBAR",
        url: origin,
        icons: [`${origin}/favicon.png`],
      },
      LedgerId.TESTNET,
      scaffoldConfig.walletConnectProjectId,
      Object.values(shared.HederaJsonRpcMethod),
      [shared.HederaSessionEvent.ChainChanged, shared.HederaSessionEvent.AccountsChanged],
      [shared.HederaChainId.Testnet],
      "error",
    );
    await connector.init({ logger: "error" });
    return connector;
  })().catch(error => {
    connectorPromise = null;
    throw error;
  });
  return connectorPromise;
}

function extensionsOf(connector: DAppConnector): WalletExtension[] {
  return connector.extensions
    .filter(extension => extension.available)
    .map(({ id, name, icon }) => ({ id, ...(name ? { name } : {}), ...(icon ? { icon } : {}) }));
}

function accountOf(connector: DAppConnector): string | null {
  return connector.signers[0]?.getAccountId().toString() ?? null;
}

/**
 * Call `listener` when the wallet ends or changes the session from its side
 * (disconnect in the wallet, account switch). The connector registered its
 * own handlers first, so its signers are current by the time this runs.
 */
function onSessionChange(connector: DAppConnector, listener: () => void): () => void {
  const client = connector.walletConnectClient;
  if (!client) return () => undefined;
  const events = ["session_delete", "session_update", "session_event"] as const;
  const later = () => setTimeout(listener, 0);
  events.forEach(event => client.on(event, later));
  client.core.events.on("session_delete", later);
  return () => {
    events.forEach(event => client.removeListener(event, later));
    client.core.events.removeListener("session_delete", later);
  };
}

function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return /reject|closed|cancel/i.test(text)
    ? "Connection cancelled. Try again, or run with the default account."
    : text;
}

/** The wallet connection, loaded when `enabled` first turns on. */
export function useHederaWallet(enabled: boolean) {
  const [state, setState] = useState<WalletState>({ status: "idle" });
  const connector = useRef<DAppConnector | null>(null);

  const refresh = useCallback(() => {
    const current = connector.current;
    if (!current) return;
    const accountId = accountOf(current);
    const extensions = extensionsOf(current);
    setState(accountId ? { status: "connected", accountId, extensions } : { status: "ready", extensions });
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: () => void = () => undefined;
    if (!connector.current) setState({ status: "loading" });
    loadConnector().then(
      loaded => {
        if (cancelled) return;
        connector.current = loaded;
        refresh();
        // Browser extensions announce themselves shortly after the connector starts listening.
        timer = setTimeout(refresh, 800);
        unsubscribe = onSessionChange(loaded, refresh);
      },
      error => !cancelled && setState({ status: "error", message: messageOf(error), extensions: [] }),
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
      unsubscribe();
    };
  }, [enabled, refresh]);

  const connect = useCallback(
    async (extensionId?: string) => {
      const current = connector.current;
      if (!current) return;
      const extensions = extensionsOf(current);
      setState({ status: "connecting", extensions });
      try {
        if (extensionId) await current.connectExtension(extensionId);
        else await current.openModal(undefined, true);
        refresh();
      } catch (error) {
        setState({ status: "error", message: messageOf(error), extensions });
      }
    },
    [refresh],
  );

  const disconnect = useCallback(async () => {
    const current = connector.current;
    if (!current) return;
    await current.disconnectAll().catch(() => undefined);
    refresh();
  }, [refresh]);

  const signer = useCallback((): Signer | null => {
    return (connector.current?.signers[0] as unknown as Signer | undefined) ?? null;
  }, []);

  return { state, connect, disconnect, signer };
}
