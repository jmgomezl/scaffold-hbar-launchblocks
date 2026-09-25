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
    <div className="min-h-0 py-5 px-1 mb-11 lg:mb-0">
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
      <div className="w-full">
        <ul className="menu menu-horizontal w-full">
          <div className="flex flex-wrap justify-center items-center gap-3 text-sm w-full text-base-content/60">
            <a
              href="https://github.com/jmgomezl/scaffold-hbar-launchblocks"
              target="_blank"
              rel="noreferrer"
              className="link hover:text-primary"
            >
              LaunchBlocks on GitHub
            </a>
            <span className="opacity-30">|</span>
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
            <span className="opacity-30">|</span>
            <a
              href="https://github.com/hedera-dev/scaffold-hbar"
              target="_blank"
              rel="noreferrer"
              className="link hover:text-primary"
            >
              Scaffold-HBAR
            </a>
            <span className="opacity-30">|</span>
            <a href="https://docs.hedera.com/" target="_blank" rel="noreferrer" className="link hover:text-primary">
              Docs
            </a>
          </div>
        </ul>
      </div>
    </div>
  );
};
