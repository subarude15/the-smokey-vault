/**
 * The Smokey Barrel brand mark (PR147). The blackletter "SB" + hop/scroll
 * filigree is the primary identity anchor. The artwork is white/gold on a keyed
 * (transparent) background, so it is always presented on a warm near-black
 * medallion — that keeps the letters crisp in BOTH Light and Dark themes without
 * any fake-metal treatment. Size is set by the consumer (class or `size`).
 */
export function SbMark({ className, size }: { className?: string; size?: number }) {
  return (
    <span
      className={`sb-medallion${className ? ` ${className}` : ""}`}
      style={size ? { width: size, height: size } : undefined}
      aria-hidden="true"
    >
      <img src="/brand/sb-monogram.webp" alt="" draggable={false} />
    </span>
  );
}
