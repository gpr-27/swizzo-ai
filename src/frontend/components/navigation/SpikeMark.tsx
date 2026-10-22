// The brand prefix: a small 4-spoke radial spike-mark (asterisk-like glyph).
// Inline SVG so it stays crisp at any size and inherits `currentColor`.

export function SpikeMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      {/* Four tapered spokes radiating from the centre, with concave sides so
          the glyph reads as a sharp sparkle rather than a plain plus. */}
      <path d="M12 1.5c.55 5.3 4.7 9.45 10 10-5.3.55-9.45 4.7-10 10-.55-5.3-4.7-9.45-10-10 5.3-.55 9.45-4.7 10-10Z" />
    </svg>
  );
}

export default SpikeMark;
