// §10: Deep Well background, no syntax highlighting beyond the three-color
// rule (ink-primary text, primary for keys/keywords, ink-tertiary for
// punctuation) so code never competes with the violet accent's meaning.
export function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-md bg-deep-well p-4">
      <code className="font-geist-mono text-mono-body text-ink-primary">
        {children}
      </code>
    </pre>
  );
}
