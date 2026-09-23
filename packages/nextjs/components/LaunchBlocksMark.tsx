/**
 * The colours Blockly derives from each step category's hue, for markup that
 * draws blocks without Blockly (the logo mark, the home page illustration).
 */
export const BLOCK_COLOUR = {
  launch: "#3c3c3c",
  hts: "#5b8da6",
  hcs: "#9a5ba6",
  saucerswap: "#a6805b",
} as const;

/**
 * The LaunchBlocks logo mark: the hero flow's first three blocks (HTS token,
 * HCS log, SaucerSwap pool) snapped together. `public/favicon.svg` is the
 * same drawing; keep them in step.
 */
export const LaunchBlocksMark = ({ className }: { className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" className={className} aria-hidden>
    <path fill={BLOCK_COLOUR.hts} d="M5 4H17Q19 4 19 6V10Q19 12 17 12H13L11.5 14H8.5L7 12H5Q3 12 3 10V6Q3 4 5 4Z" />
    <path
      fill={BLOCK_COLOUR.hcs}
      d="M5 12H7L8.5 14H11.5L13 12H23Q25 12 25 14V18Q25 20 23 20H13L11.5 22H8.5L7 20H5Q3 20 3 18V14Q3 12 5 12Z"
    />
    <path
      fill={BLOCK_COLOUR.saucerswap}
      d="M5 20H7L8.5 22H11.5L13 20H27Q29 20 29 22V26Q29 28 27 28H5Q3 28 3 26V22Q3 20 5 20Z"
    />
  </svg>
);
