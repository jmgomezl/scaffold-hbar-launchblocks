import type { Metadata } from "next";

const baseUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL
  ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
  : `http://localhost:${process.env.PORT || 3000}`;
const titleTemplate = "%s | LaunchBlocks";

/** The default share image; its source is docs/images/thumbnail.html. */
const THUMBNAIL = {
  path: "/thumbnail.jpg",
  width: 1200,
  height: 630,
  alt: "LaunchBlocks: launch a token, give it a market, block by block. A launch built from Hedera blocks, each marked done.",
};

export const getMetadata = ({
  title,
  description,
  imageRelativePath = THUMBNAIL.path,
  path,
}: {
  title: string;
  description: string;
  imageRelativePath?: string;
  /** The page's own path, e.g. "/launches": its canonical URL and og:url. */
  path?: string;
}): Metadata => {
  const imageUrl = `${baseUrl}${imageRelativePath}`;
  // Sizes let Facebook and LinkedIn show the image on a link's first share.
  const image =
    imageRelativePath === THUMBNAIL.path
      ? { url: imageUrl, width: THUMBNAIL.width, height: THUMBNAIL.height, alt: THUMBNAIL.alt }
      : { url: imageUrl };

  return {
    metadataBase: new URL(baseUrl),
    title: {
      default: title,
      template: titleTemplate,
    },
    description: description,
    ...(path ? { alternates: { canonical: path } } : {}),
    openGraph: {
      title: {
        default: title,
        template: titleTemplate,
      },
      description: description,
      ...(path ? { url: path } : {}),
      siteName: "LaunchBlocks",
      type: "website",
      images: [image],
    },
    twitter: {
      title: {
        default: title,
        template: titleTemplate,
      },
      description: description,
      images: [image],
    },
    icons: {
      icon: [
        { url: "/favicon.svg", type: "image/svg+xml" },
        { url: "/favicon.png", sizes: "256x256", type: "image/png" },
      ],
    },
  };
};
