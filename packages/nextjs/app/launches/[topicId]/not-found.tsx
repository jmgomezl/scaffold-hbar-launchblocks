import Link from "next/link";
import { FindLaunch } from "../_components/FindLaunch";

export default function LaunchNotFound() {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 px-5 py-12">
      <div className="rounded-2xl bg-base-100 p-6 shadow-lg md:p-8">
        <h1 className="text-2xl font-bold">No launch log with that id</h1>
        <p className="mb-6 mt-2 text-base-content/70">
          A launch page needs the HCS topic a launch opened, such as 0.0.10716076, on this app&apos;s network.
        </p>
        <FindLaunch />
      </div>
      <p className="text-sm">
        <Link href="/launches" className="link link-primary">
          See real launches
        </Link>
      </p>
    </div>
  );
}
