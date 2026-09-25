"use client";

import type { WalletExtension, WalletState } from "../_lib/wallet";
import type { FlowInput } from "@sh/launchblocks/editor";
import { ArrowTopRightOnSquareIcon } from "@heroicons/react/24/outline";

export type SignerMode = "operator" | "wallet";

const HASHSCAN = "https://hashscan.io/testnet/account";

/**
 * How many times a wallet will ask for approval: one per transaction. Pool
 * creation sends three (create the pair, approve the router, deposit), and
 * view or pure contract calls are read free, with none.
 */
export function walletApprovals(flow: FlowInput | undefined): number {
  return (flow?.steps ?? []).reduce((count, step) => {
    if (step.type === "saucerswap.createPool") return count + 3;
    if (step.type === "contract.call") {
      const signature = String((step.params as Record<string, unknown> | undefined)?.function ?? "");
      return count + (/\b(view|pure)\b/.test(signature) ? 0 : 1);
    }
    return count + 1;
  }, 0);
}

function AccountLink({ accountId }: { accountId: string }) {
  return (
    <a
      href={`${HASHSCAN}/${accountId}`}
      target="_blank"
      rel="noreferrer"
      className="link inline-flex items-center gap-0.5 font-mono"
    >
      {accountId}
      <ArrowTopRightOnSquareIcon className="h-3 w-3" />
    </a>
  );
}

type Props = {
  mode: SignerMode;
  onModeChange: (mode: SignerMode) => void;
  operatorAccountId: string | null;
  wallet: WalletState;
  onConnect: (extensionId?: string) => void;
  onDisconnect: () => void;
  approvals: number;
  disabled: boolean;
};

/**
 * Who signs the next run: the app's operator account by default (on the
 * hosted demo, a funded demo account), or the visitor's own testnet wallet.
 */
export function SignerPicker({
  mode,
  onModeChange,
  operatorAccountId,
  wallet,
  onConnect,
  onDisconnect,
  approvals,
  disabled,
}: Props) {
  const extensions: WalletExtension[] = "extensions" in wallet ? wallet.extensions : [];
  return (
    <fieldset className="mb-4 space-y-2 rounded-lg border border-base-300 p-3 text-sm" disabled={disabled}>
      <legend className="px-1 text-xs font-semibold uppercase tracking-wide opacity-70">Sign with</legend>

      <label className="flex cursor-pointer items-start gap-2">
        <input
          type="radio"
          name="signer"
          className="radio radio-primary radio-sm mt-0.5"
          checked={mode === "operator"}
          onChange={() => onModeChange("operator")}
        />
        <span>
          <span className="font-medium">Default account</span>{" "}
          <span className="badge badge-primary badge-sm align-middle">no setup</span>
          <span className="block text-xs opacity-70">
            {operatorAccountId ? (
              <>
                The app&apos;s testnet account <AccountLink accountId={operatorAccountId} /> signs and pays for the run.
                Nothing to connect or fund.
              </>
            ) : (
              <>
                The app&apos;s operator account signs and pays. None is set yet: add <code>HEDERA_OPERATOR_ID</code> and{" "}
                <code>HEDERA_OPERATOR_KEY</code> to <code>packages/nextjs/.env</code>, or connect a wallet.
              </>
            )}
          </span>
        </span>
      </label>

      <label className="flex cursor-pointer items-start gap-2">
        <input
          type="radio"
          name="signer"
          className="radio radio-primary radio-sm mt-0.5"
          checked={mode === "wallet"}
          onChange={() => onModeChange("wallet")}
        />
        <span>
          <span className="font-medium">Your testnet wallet</span>
          <span className="block text-xs opacity-70">
            HashPack, Kabila or any Hedera wallet: you approve each transaction and pay from your own account.
          </span>
        </span>
      </label>

      {mode === "wallet" && (
        <div className="ml-6 space-y-2 text-xs">
          {wallet.status === "loading" && (
            <p className="flex items-center gap-2 opacity-70">
              <span className="loading loading-spinner loading-xs" /> Loading the wallet connection…
            </p>
          )}
          {(wallet.status === "ready" || wallet.status === "error") && (
            <>
              {wallet.status === "error" && <p className="text-error">{wallet.message}</p>}
              <div className="flex flex-wrap gap-1.5">
                {extensions.map(extension => (
                  <button
                    key={extension.id}
                    type="button"
                    className="btn btn-xs"
                    onClick={() => onConnect(extension.id)}
                  >
                    {extension.icon ? (
                      // The wallet announces its icon as a data or remote URL; next/image would need every host listed.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={extension.icon} alt="" className="h-3.5 w-3.5" />
                    ) : null}
                    {extension.name ?? "Wallet extension"}
                  </button>
                ))}
                <button type="button" className="btn btn-xs btn-outline" onClick={() => onConnect()}>
                  {extensions.length ? "Other wallet (QR code)" : "Connect a wallet (QR code)"}
                </button>
              </div>
              {!extensions.length && (
                <p className="opacity-60">
                  No wallet extension found in this browser; scan the code with a mobile wallet.
                </p>
              )}
            </>
          )}
          {wallet.status === "connecting" && (
            <p className="flex items-center gap-2">
              <span className="loading loading-spinner loading-xs" /> Approve the connection in your wallet…
            </p>
          )}
          {wallet.status === "connected" && (
            <>
              <p className="flex flex-wrap items-center gap-2">
                <span className="badge badge-success badge-sm">connected</span>
                <AccountLink accountId={wallet.accountId} />
                <button type="button" className="btn btn-ghost btn-xs" onClick={onDisconnect}>
                  Disconnect
                </button>
              </p>
              <p className="opacity-70">
                This launch will ask for about <strong>{approvals}</strong> approval{approvals === 1 ? "" : "s"}, one
                per transaction. Testnet only; switch back to the default account at any time.
              </p>
            </>
          )}
        </div>
      )}
    </fieldset>
  );
}
