/** ORCID's iD mark: a green disc with "iD". */
export function OrcidMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <circle cx="8" cy="8" r="8" fill="#a6ce39" />
      <text x="8" y="11.2" textAnchor="middle" fontSize="8.5" fontWeight="700" fill="#fff" fontFamily="system-ui, sans-serif">
        iD
      </text>
    </svg>
  );
}
