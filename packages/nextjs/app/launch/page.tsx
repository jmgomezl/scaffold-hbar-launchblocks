import { LaunchStudio } from "./_components/LaunchStudio";
import type { NextPage } from "next";
import { getMetadata } from "~~/utils/scaffold-hbar/getMetadata";

export const metadata = getMetadata({
  title: "Launch Studio",
  description:
    "Compose a Hedera token launch from blocks (HTS, HCS, the Schedule Service, contracts and SaucerSwap) and run it on testnet, signed by the app's account or your own wallet.",
});

const LaunchPage: NextPage = () => <LaunchStudio />;

export default LaunchPage;
