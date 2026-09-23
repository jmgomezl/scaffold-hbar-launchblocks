import { BLOCK_COLOUR as COLOUR } from "~~/components/LaunchBlocksMark";

/**
 * A static drawing of the hero flow as it appears in the Launch Studio. Pure
 * markup, so it renders on the server and costs no JavaScript.
 */

type Row = { label: string; id: string; colour: string; reporter?: { text: string; colour: string } };

const ROWS: Row[] = [
  { label: "Create HTS token", id: "createToken", colour: COLOUR.hts },
  { label: "Create HCS topic", id: "createLog", colour: COLOUR.hcs },
  {
    label: "Seed SaucerSwap pool",
    id: "seedPool",
    colour: COLOUR.saucerswap,
    reporter: { text: "createToken ▸ Token", colour: COLOUR.hts },
  },
  {
    label: "Buy with HBAR",
    id: "firstTrade",
    colour: COLOUR.saucerswap,
    reporter: { text: "createToken ▸ Token", colour: COLOUR.hts },
  },
  {
    label: "Log to HCS topic",
    id: "recordMarket",
    colour: COLOUR.hcs,
    reporter: { text: "createLog ▸ Topic", colour: COLOUR.hcs },
  },
];

export function LaunchIllustration() {
  return (
    <div
      className="w-full max-w-lg overflow-hidden rounded-xl bg-black/20 p-4 font-medium text-white shadow-2xl ring-1 ring-white/10 backdrop-blur-sm"
      role="img"
      aria-label="A launch built from blocks: create an HTS token, create an HCS topic, seed a SaucerSwap pool, buy with HBAR, and log to the HCS topic, each marked done"
    >
      <div className="rounded-md text-[13px]" style={{ backgroundColor: COLOUR.launch }}>
        <div className="flex items-center gap-2 px-3 py-2">
          <span aria-hidden>🚀</span>
          <span>Launch</span>
          <span className="rounded bg-white/90 px-1.5 py-0.5 text-[12px] text-neutral-800">My token launch</span>
          <span className="opacity-80">on testnet</span>
        </div>
        <div className="space-y-1 pb-2 pl-3 pr-2">
          {ROWS.map(row => (
            <div key={row.id} className="flex items-center gap-2">
              <div
                className="flex shrink-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-[12px] shadow-sm"
                style={{ backgroundColor: row.colour }}
              >
                <span aria-hidden className="text-[11px]">
                  ✅
                </span>
                <span className="whitespace-nowrap">{row.label}</span>
                <span className="hidden opacity-80 sm:inline">as</span>
                <span className="hidden rounded bg-white/90 px-1 text-[11px] text-neutral-800 sm:inline">{row.id}</span>
              </div>
              {row.reporter && (
                <span
                  className="hidden truncate whitespace-nowrap rounded-md px-2 py-1 text-[11px] shadow-sm sm:inline"
                  style={{ backgroundColor: row.reporter.colour }}
                >
                  {row.reporter.text}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
