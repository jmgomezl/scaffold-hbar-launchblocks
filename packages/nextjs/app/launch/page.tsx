import { LaunchStudio } from "./_components/LaunchStudio";
import type { NextPage } from "next";
import { getMetadata } from "~~/utils/scaffold-hbar/getMetadata";

export const metadata = getMetadata({
  title: "Launch Studio",
  description:
    "Compose a Hedera token launch from blocks — HTS token, HCS launch log, SaucerSwap pool — and run it on testnet.",
});

const LaunchPage: NextPage = () => <LaunchStudio />;

export default LaunchPage;
