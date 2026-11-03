export default function Loading() {
  return (
    <div className="loading-skeleton animate-pulse space-y-4" aria-busy="true" aria-label="Memuat">
      <div className="h-7 w-48 rounded bg-slate-200" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-20 rounded-xl bg-slate-200" />
        ))}
      </div>
      <div className="h-64 rounded-xl bg-slate-200" />
    </div>
  );
}
