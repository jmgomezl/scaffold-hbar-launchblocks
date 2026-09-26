import { BLOCK_COLOUR } from "~~/components/LaunchBlocksMark";

export type AvatarMood = "idle" | "thinking" | "worried";

/** Where the pupils look: at you, up while it thinks, and straight at you, a little alarmed, when worried. */
const PUPILS: Record<AvatarMood, { dx: number; dy: number }> = {
  idle: { dx: 0.4, dy: 0.5 },
  thinking: { dx: 0.9, dy: -0.9 },
  worried: { dx: 0, dy: 0.2 },
};

/**
 * Blocky, the studio assistant's face: the LaunchBlocks logo mark come to
 * life. Its head, body and base are the hero flow's first three blocks (HTS
 * token, HCS log, SaucerSwap pool), with googly eyes and a sparkle for an
 * antenna, sitting on a rocket flame, since this is a launchpad. It blinks
 * and bobs when idle; while it thinks, its eyes roll up and the flame roars;
 * with a problem or a warning on screen, it looks worried. Motion stops for
 * people who ask for reduced motion.
 */
export function AssistantAvatar({ mood = "idle", className }: { mood?: AvatarMood; className?: string }) {
  const { dx, dy } = PUPILS[mood];
  return (
    <svg viewBox="0 0 32 42" className={`lb-avatar ${className ?? ""}`} data-mood={mood} aria-hidden="true">
      {/* The rocket flame under the base: a pilot light, roaring while it thinks. */}
      <g className="lb-flame">
        <path d="M11 34Q16 44 21 34Z" fill="#ff8863" />
        <path d="M13.5 34Q16 40 18.5 34Z" fill="#ffcf72" />
      </g>

      {/* The antenna and its sparkle. */}
      <path d="M11 10V5" stroke={BLOCK_COLOUR.launch} strokeWidth="1.2" strokeLinecap="round" />
      <path
        className="lb-sparkle"
        d="M11 0.6L12 3.1L14.4 4L12 4.9L11 7.4L10 4.9L7.6 4L10 3.1Z"
        fill="#8259ef"
        stroke="#fff"
        strokeWidth="0.5"
      />

      {/* The logo mark's three blocks, 6 units lower to make room for the antenna. */}
      <g transform="translate(0 6)">
        <path fill={BLOCK_COLOUR.hts} d="M5 4H17Q19 4 19 6V10Q19 12 17 12H13L11.5 14H8.5L7 12H5Q3 12 3 10V6Q3 4 5 4Z" />
        <path
          fill={BLOCK_COLOUR.hcs}
          d="M5 12H7L8.5 14H11.5L13 12H23Q25 12 25 14V18Q25 20 23 20H13L11.5 22H8.5L7 20H5Q3 20 3 18V14Q3 12 5 12Z"
        />
        <path
          fill={BLOCK_COLOUR.saucerswap}
          d="M5 20H7L8.5 22H11.5L13 20H27Q29 20 29 22V26Q29 28 27 28H5Q3 28 3 26V22Q3 20 5 20Z"
        />
      </g>

      {/* Googly eyes on the head block; they blink. */}
      <g className="lb-eyes">
        <circle cx="7.6" cy="14" r="2.6" fill="#fff" stroke="#11151d" strokeWidth="0.4" />
        <circle cx="14.2" cy="14" r="2.6" fill="#fff" stroke="#11151d" strokeWidth="0.4" />
        <circle cx={7.6 + dx} cy={14 + dy} r="1.15" fill="#11151d" />
        <circle cx={14.2 + dx} cy={14 + dy} r="1.15" fill="#11151d" />
      </g>

      {/* Brows, only when worried: raised toward the middle (sloping down toward it would read as angry). */}
      {mood === "worried" && (
        <g stroke="#11151d" strokeWidth="0.8" strokeLinecap="round">
          <path d="M5.2 11.3L9 10.1" />
          <path d="M16.6 11.3L12.8 10.1" />
        </g>
      )}

      {/* The mouth, on the second block: a grin, an "o" while it thinks, a wobble when worried. */}
      {mood === "thinking" ? (
        <circle cx="11" cy="22.2" r="1.1" fill="#11151d" />
      ) : mood === "worried" ? (
        <path
          d="M7.6 22.6Q9.3 21.4 11 22.6T14.4 22.6"
          fill="none"
          stroke="#fff"
          strokeWidth="0.9"
          strokeLinecap="round"
        />
      ) : (
        <path d="M7.4 21.4Q11 24.8 14.6 21.4" fill="none" stroke="#fff" strokeWidth="1" strokeLinecap="round" />
      )}
    </svg>
  );
}
