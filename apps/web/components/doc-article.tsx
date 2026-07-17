export function DocArticle({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <article>
      <h1 className="font-geist-sans text-heading-lg font-medium text-ink-primary">
        {title}
      </h1>
      <div className="prose-doc mt-6 flex flex-col gap-4">{children}</div>
    </article>
  );
}

export function DocHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mt-4 text-heading-sm font-medium text-ink-primary">
      {children}
    </h2>
  );
}

export function DocP({ children }: { children: React.ReactNode }) {
  return <p className="text-body-lg text-ink-secondary">{children}</p>;
}

export function DocTerm({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-geist-mono text-mono-body text-ink-primary">
      {children}
    </span>
  );
}
