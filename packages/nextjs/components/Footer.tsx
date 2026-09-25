import React from "react";
import { usePathname } from "next/navigation";
import { HederaPortalFaucet } from "@scaffold-hbar-ui/components";
import { hedera } from "viem/chains";
import { CurrencyDollarIcon } from "@heroicons/react/24/outline";
import { SwitchTheme } from "~~/components/SwitchTheme";
import { useFetchHbarPrice } from "~~/hooks/scaffold-hbar";
import { useTargetNetwork } from "~~/hooks/scaffold-hbar/useTargetNetwork";

/**
 * Site footer
 */
export const Footer = () => {
  const { targetNetwork } = useTargetNetwork();
  const isTestnet = targetNetwork.id !== hedera.id;
  const { price: nativeCurrencyPrice } = useFetchHbarPrice();
  // On a phone the studio's panel runs to the bottom of the page, under these floating buttons.
  const inStudio = usePathname() === "/launch";

  return (
    // Room at the bottom for the fixed bar (two rows on a phone), so it never covers the links. The studio
    // sizes itself to the viewport around the bar, and on a phone the bar sits in its flow instead.
    <footer className={`min-h-0 py-5 px-1 ${inStudio ? "" : "mb-24 md:mb-14"}`}>
      <div>
        <div
          className={`fixed flex justify-between items-center w-full z-10 p-4 bottom-0 left-0 pointer-events-none ${inStudio ? "max-lg:static" : ""}`}
        >
          <div className="flex flex-col md:flex-row gap-2 pointer-events-auto">
            {nativeCurrencyPrice > 0 && (
              <div>
                <div className="btn btn-primary btn-sm font-normal gap-1 cursor-auto">
                  <CurrencyDollarIcon className="h-4 w-4" />
                  <span>{nativeCurrencyPrice.toFixed(2)}</span>
                </div>
              </div>
            )}
            {isTestnet && <HederaPortalFaucet showIcon />}
          </div>
          <SwitchTheme className="pointer-events-auto" />
        </div>
      </div>
      <nav aria-label="Links" className="w-full">
        <div className="flex flex-wrap justify-center items-center gap-x-3 gap-y-1 text-sm w-full text-base-content/70">
          <a
            href="https://github.com/jmgomezl/scaffold-hbar-launchblocks"
            target="_blank"
            rel="noreferrer"
            className="link hover:text-primary"
          >
            LaunchBlocks on GitHub
          </a>
          <span aria-hidden="true" className="opacity-30 max-sm:hidden">
            |
          </span>
          <span>
            Built on{" "}
            <a
              href="https://hedera.com/"
              target="_blank"
              rel="noreferrer"
              className="font-semibold link hover:text-primary"
            >
              Hedera
            </a>
          </span>
          <span aria-hidden="true" className="opacity-30 max-sm:hidden">
            |
          </span>
          <a
            href="https://github.com/hedera-dev/scaffold-hbar"
            target="_blank"
            rel="noreferrer"
            className="link hover:text-primary"
          >
            Scaffold-HBAR
          </a>
          <span aria-hidden="true" className="opacity-30 max-sm:hidden">
            |
          </span>
          <a href="https://docs.hedera.com/" target="_blank" rel="noreferrer" className="link hover:text-primary">
            Docs
          </a>
        </div>
      </nav>
    </footer>
  );
};
