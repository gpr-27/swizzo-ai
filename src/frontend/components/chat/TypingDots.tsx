// A refined "thinking" indicator shown while the assistant is composing a reply.
// Three coral dots that gently bob + breathe in a staggered wave (the shared
// `animate-thinking` keyframes) — deliberate thought, not a frantic spinner.
// Prop API is unchanged (optional className) so every caller keeps working.

export function TypingDots({ className }: { className?: string }) {
  return (
    <span
      className={`inline-flex items-end gap-[3px] ${className ?? ''}`}
      aria-label="Assistant is thinking"
      role="status"
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="block h-1.5 w-1.5 rounded-full bg-coral animate-thinking"
          // Staggered start so the dots read as a travelling wave.
          style={{ animationDelay: `${i * 0.16}s` }}
        />
      ))}
    </span>
  );
}

export default TypingDots;
