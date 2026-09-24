import "@rainbow-me/rainbowkit/styles.css";
import "@scaffold-hbar-ui/components/styles.css";
import { ScaffoldHbarAppWithProviders } from "~~/components/ScaffoldHbarAppWithProviders";
import { ThemeProvider } from "~~/components/ThemeProvider";
import "~~/styles/globals.css";
import { getMetadata } from "~~/utils/scaffold-hbar/getMetadata";

// The home page inherits this title as is; other pages get "<title> | LaunchBlocks".
export const metadata = getMetadata({
  title: "LaunchBlocks",
  description:
    "A visual token launchpad for Hedera. Snap together an HTS token, an HCS launch log, a SaucerSwap pool, locked liquidity and scheduled unlocks, then run it on testnet or export it as code.",
});

const ScaffoldHbarApp = ({ children }: { children: React.ReactNode }) => {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider enableSystem>
          <ScaffoldHbarAppWithProviders>{children}</ScaffoldHbarAppWithProviders>
        </ThemeProvider>
      </body>
    </html>
  );
};

export default ScaffoldHbarApp;
