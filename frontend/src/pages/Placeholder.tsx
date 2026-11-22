export function Placeholder({ name, phase }: { name: string; phase?: string }) {
  return (
    <section className="card narrow">
      <h1>{name}</h1>
      {phase && <p className="muted">Coming in {phase}.</p>}
    </section>
  );
}
