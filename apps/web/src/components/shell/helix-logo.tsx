/* Helix logo — rounded violet-gradient square with three helix-curve strokes.
   Ported from the design handoff (shell.jsx → HelixLogo). Replace with the
   real Helix logo when it lands. */

export interface HelixLogoProps {
  size?: number;
}

export function HelixLogo({ size = 22 }: HelixLogoProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-label="Helix">
      <defs>
        <linearGradient id="hx-grad" x1="0" y1="0" x2="24" y2="24">
          <stop offset="0" stopColor="oklch(72% 0.18 290)" />
          <stop offset="1" stopColor="oklch(50% 0.22 290)" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="20" height="20" rx="5" fill="url(#hx-grad)" />
      <path d="M7 6c3 3 7 3 10 0" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" fill="none" />
      <path d="M7 12c3 3 7 3 10 0" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" fill="none" />
      <path d="M7 18c3 3 7 3 10 0" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" fill="none" />
    </svg>
  );
}
