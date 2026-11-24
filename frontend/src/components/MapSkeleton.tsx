/** Fixed-height placeholder matching the demo map section, to avoid layout shift while it loads. */
export function MapSkeleton() {
  return (
    <section className="demo-map demo-skeleton" aria-label="Loading demo laundry map" aria-busy="true">
      <div className="demo-skeleton-block" />
    </section>
  );
}
