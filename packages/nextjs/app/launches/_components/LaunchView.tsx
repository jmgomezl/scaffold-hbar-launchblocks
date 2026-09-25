import Link from "next/link";
import {
  eventTitle,
  fieldLabel,
  formatAmount,
  formatDate,
  linkFor,
  loggedAmount,
  loggedDate,
  priceChange,
  relativeTime,
  saucerswapPoolUrl,
} from "../_lib/format";
import type { LaunchLogEntry, LaunchRecord, Network } from "@sh/launchblocks";
import { hashscanUrl } from "@sh/launchblocks";
import { ArrowTopRightOnSquareIcon } from "@heroicons/react/24/outline";

function External({
  href,
  children,
  className = "link link-primary",
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <a href={href} target="_blank" rel="noreferrer nofollow" className={`${className} inline-flex items-center gap-1`}>
      {children}
      <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5 shrink-0" />
    </a>
  );
}

const MAX_SHOWN = 400;

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-base-300 bg-base-100 p-5">
      <p className="mb-2 text-xs font-medium uppercase tracking-widest text-base-content/70">{title}</p>
      {children}
    </div>
  );
}

/** A logged value: a link when it is an id or https URL, nested fields for an object, else plain text. */
function Value({ network, name, value }: { network: Network; name: string; value: unknown }) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return <Fields network={network} data={value as Record<string, unknown>} />;
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const date = loggedDate(name, value);
  if (date) {
    return (
      <span title={text}>
        {date} <span className="font-mono text-xs text-base-content/70">{text}</span>
      </span>
    );
  }
  const amount = loggedAmount(value);
  if (amount) return <span className="font-mono">{amount}</span>;
  const href = typeof value === "string" ? linkFor(network, name, value) : null;
  // The whole message is under "The message as recorded"; a field shows its first 400 characters.
  if (!href && text.length > MAX_SHOWN) {
    return (
      <span className="break-all font-mono">
        {text.slice(0, MAX_SHOWN)}…{" "}
        <span className="text-base-content/70">({text.length - MAX_SHOWN} more characters)</span>
      </span>
    );
  }
  return href ? (
    <External href={href} className="link link-primary break-all font-mono">
      {text}
    </External>
  ) : (
    <span className="break-all font-mono">{text}</span>
  );
}

function Fields({ network, data }: { network: Network; data: Record<string, unknown> }) {
  const entries = Object.entries(data).filter(([key]) => key !== "event");
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[minmax(0,11rem)_1fr]">
      {entries.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="mt-1 text-xs text-base-content/70 sm:mt-0 sm:text-sm">{fieldLabel(key)}</dt>
          <dd className="min-w-0">
            <Value network={network} name={key} value={value} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Entry({ network, entry }: { network: Network; entry: LaunchLogEntry }) {
  return (
    <li className="relative ml-6">
      <span
        className={`absolute -left-[31px] top-1.5 h-3 w-3 rounded-full ring-4 ring-base-200 ${entry.fromLauncher ? "hedera-gradient" : "bg-warning"}`}
      />
      {!entry.fromLauncher && (
        <span className="badge badge-warning badge-soft badge-sm mb-1">Posted by another account</span>
      )}
      <p className="text-xs text-base-content/70">
        #{entry.sequence} · {formatDate(entry.consensusAt)}
        {entry.payerAccountId && (
          <>
            {" "}
            · paid by{" "}
            <a
              className="link"
              href={hashscanUrl(network, "account", entry.payerAccountId)}
              target="_blank"
              rel="noreferrer nofollow"
            >
              {entry.payerAccountId}
            </a>
          </>
        )}
      </p>
      <h3 className="mb-2 mt-0.5 text-lg font-semibold">{entry.data ? eventTitle(entry.data.event) : "Note"}</h3>
      {entry.data ? (
        <Fields network={network} data={entry.data} />
      ) : (
        <p className="whitespace-pre-wrap break-words text-sm">{entry.text}</p>
      )}
      <details className="mt-2 text-xs">
        <summary className="cursor-pointer text-base-content/70">The message as recorded</summary>
        <pre className="mt-1 max-h-60 overflow-auto rounded-lg bg-base-200 p-2">{entry.text}</pre>
      </details>
    </li>
  );
}

export function LaunchView({ launch }: { launch: LaunchRecord }) {
  const { network, token, pool, lock, schedules, entries } = launch;
  const market = entries.find(entry => entry.data?.event === "market.opened")?.data;
  const poolUrl = saucerswapPoolUrl(market?.poolUrl);
  // From the reserves themselves: the shown price is cut to 8 decimals, which can move the change by 0.01 point.
  const change = pool
    ? priceChange(pool.openingPriceHbar, String(Number(pool.hbarReserve) / Number(pool.tokenReserve)))
    : null;

  return (
    <div className="mx-auto w-full max-w-5xl space-y-8 px-5 py-10">
      <section className="rounded-2xl bg-base-100 p-6 shadow-lg md:p-8">
        <p className="text-xs font-medium uppercase tracking-widest text-base-content/70">
          Launch log · Hedera {network}
        </p>
        <h1 className="mt-1 text-3xl font-bold">
          {token ? token.name : launch.memo || `Topic ${launch.topicId}`}
          {token && (
            <>
              {" "}
              <span className="ml-2 text-xl font-medium text-base-content/70">{token.symbol}</span>
            </>
          )}
        </h1>
        <p className="mt-3 max-w-3xl text-base-content/70">
          Rebuilt from HCS topic{" "}
          <External href={hashscanUrl(network, "topic", launch.topicId)}>{launch.topicId}</External>
          {launch.memo ? ` (“${launch.memo}”)` : ""}: {entries.length} entr{entries.length === 1 ? "y" : "ies"}
          {launch.createdAt ? `, opened ${formatDate(launch.createdAt)}` : ""}. Hedera orders and timestamps each one
          and nobody can change it afterwards. Everything here is read from the mirror node as you open the page.
        </p>
        {launch.openToAll && (
          <div role="note" className="alert alert-warning alert-soft mt-4 text-sm">
            <span>
              This topic has no submit key, so anyone can post to it. The cards below use only the messages paid by{" "}
              {launch.launcherAccountId ?? "the account"} that wrote the first one; any others are marked in the log.
            </span>
          </div>
        )}
      </section>

      {(token || pool || lock || schedules.length > 0) && (
        <section aria-label="The launch now" className="grid gap-4 md:grid-cols-2">
          {token && (
            <Card title="Token">
              <p className="text-2xl font-bold">
                {formatAmount(token.totalSupply)} <span className="text-base font-medium">{token.symbol}</span>
              </p>
              <p className="text-sm text-base-content/70">total supply, {token.decimals} decimals</p>
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                <External href={hashscanUrl(network, "token", token.tokenId)}>Token {token.tokenId}</External>
                {token.treasuryAccountId && (
                  <External href={hashscanUrl(network, "account", token.treasuryAccountId)}>
                    Treasury {token.treasuryAccountId}
                  </External>
                )}
              </div>
            </Card>
          )}
          {pool && token && (
            <Card title="Market · SaucerSwap V1">
              <p className="text-2xl font-bold">
                {pool.priceHbar} ℏ{" "}
                {change && (
                  <span
                    className={`badge align-middle border-0 ${
                      change.startsWith("-")
                        ? "bg-error/15 text-red-700 dark:text-error"
                        : "bg-success/15 text-emerald-700 dark:text-success"
                    }`}
                  >
                    {change} since opening
                  </span>
                )}
              </p>
              <p className="text-sm text-base-content/70">
                per {token.symbol} now; the pool holds {formatAmount(pool.tokenReserve)} {token.symbol} and{" "}
                {formatAmount(pool.hbarReserve)} ℏ
                {pool.openingPriceHbar ? `. It opened at ${pool.openingPriceHbar} ℏ.` : "."}
              </p>
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                <External href={hashscanUrl(network, "contract", pool.pairId)}>Pool {pool.pairId}</External>
                {poolUrl && <External href={poolUrl}>Open on SaucerSwap</External>}
              </div>
            </Card>
          )}
          {lock && (
            <Card title="Liquidity lock">
              <p className="text-2xl font-bold">
                {lock.released ? "Released" : `${formatAmount(lock.lockedLp)} LP locked`}
              </p>
              <p className="text-sm text-base-content/70">
                {lock.releaseAt
                  ? `${lock.released ? "Release time was" : "Nobody can withdraw it until"} ${formatDate(lock.releaseAt)} (${relativeTime(lock.releaseAt)}).`
                  : "The log does not say when it unlocks."}
              </p>
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                <External href={hashscanUrl(network, "contract", lock.contractId)}>Lock {lock.contractId}</External>
                <External href={hashscanUrl(network, "token", lock.lpTokenId)}>LP token {lock.lpTokenId}</External>
              </div>
            </Card>
          )}
          {schedules.length > 0 && (
            <Card title="Scheduled transactions">
              <ul className="space-y-2 text-sm">
                {schedules.map(schedule => (
                  <li key={schedule.scheduleId}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`badge badge-sm border-0 ${
                          schedule.executedAt
                            ? "bg-success/15 text-emerald-700 dark:text-success"
                            : schedule.deleted
                              ? "badge-ghost"
                              : "bg-info/15 text-blue-700 dark:text-info"
                        }`}
                      >
                        {schedule.executedAt ? "executed" : schedule.deleted ? "deleted" : "scheduled"}
                      </span>
                      <span className="font-medium">{fieldLabel(schedule.label)}</span>
                      {schedule.amount && token && (
                        <span className="text-base-content/70">
                          {formatAmount(schedule.amount)} {token.symbol}
                        </span>
                      )}
                      <span className="ml-auto">
                        <External href={hashscanUrl(network, "schedule", schedule.scheduleId)}>
                          {schedule.scheduleId}
                        </External>
                      </span>
                    </div>
                    <p className="mt-0.5 text-base-content/70">
                      {schedule.executedAt
                        ? `Ran ${formatDate(schedule.executedAt)}`
                        : schedule.executesAt
                          ? `Runs ${formatDate(schedule.executesAt)} (${relativeTime(schedule.executesAt)})`
                          : ""}
                    </p>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-base-content/70">
                The network runs each one at its time by itself, with nobody online.
              </p>
            </Card>
          )}
        </section>
      )}

      <section aria-labelledby="log-heading" className="rounded-2xl bg-base-100 p-6 shadow-sm md:p-8">
        <h2 id="log-heading" className="mb-6 text-2xl font-bold">
          The log
        </h2>
        {entries.length ? (
          <ol className="ml-2 space-y-8 border-l-2 border-base-300 py-1">
            {entries.map(entry => (
              <Entry key={entry.sequence} network={network} entry={entry} />
            ))}
          </ol>
        ) : (
          <p className="text-base-content/70">This topic has no messages yet.</p>
        )}
      </section>

      <p className="text-center text-sm text-base-content/70">
        Launches like this one are built from blocks in the{" "}
        <Link href="/launch" className="link link-primary">
          Launch Studio
        </Link>
        : every one that opens a log gets a page like this.
      </p>
    </div>
  );
}
