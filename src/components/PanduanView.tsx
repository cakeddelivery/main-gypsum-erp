import { type Guide } from "@/lib/panduan";
import { GuideIco, Rich } from "./PanduanSheet";

const BTN = "whitespace-nowrap rounded-md border border-brand-200 bg-brand-50 px-1.5 font-semibold text-brand-700";

/** Panduan versi layar HP (isi sama dengan lembar A4): langkah bernomor yang mudah dibaca */
export function PanduanView({ guide, wa, shots = {} }: { guide: Guide; wa: string; shots?: Record<string, string> }) {
  return (
    <div className="space-y-4">
      <ol className="space-y-3">
        {guide.phases.map((ph, n) => {
          const shot = ph.shot ? shots[ph.shot] : undefined;
          return (
            <li key={n} className="card overflow-hidden">
              <div className="flex items-center gap-3 px-4 py-3 text-white" style={{ background: ph.color }}>
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-white/20"><GuideIco name={ph.icon} size={22} /></span>
                <div className="min-w-0">
                  <div className="text-xs font-semibold uppercase tracking-wide text-white/90">{ph.when}</div>
                  <div className="text-lg font-bold leading-tight">{n + 1}. {ph.title}</div>
                </div>
              </div>
              <div className="space-y-3 px-4 py-3">
                <ul className="list-disc space-y-2 pl-5 text-[15px] leading-relaxed text-slate-700">
                  {ph.items.map((t, i) => <li key={i}><Rich text={t} wa={wa} btn={BTN} /></li>)}
                </ul>
                {ph.flow && (
                  <ol className="flex flex-wrap gap-1.5" aria-label="Tahap form laporan">
                    {ph.flow.map((s, i) => <li key={s} className="rounded-full border border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-700">{i + 1}. {s}</li>)}
                  </ol>
                )}
                {shot && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={shot} alt={`Contoh layar: ${ph.title}`} className="mx-auto w-full max-w-xs rounded-xl border border-slate-200" loading="lazy" />
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {guide.periodic && (
        <section className="card px-4 py-3">
          <h2 className="font-semibold text-slate-800">Tugas mingguan / bulanan</h2>
          <ul className="mt-2 list-disc space-y-2 pl-5 text-[15px] leading-relaxed text-slate-700">
            {guide.periodic.map((t, i) => <li key={i}><Rich text={t} wa={wa} btn={BTN} /></li>)}
          </ul>
        </section>
      )}
      <section className="card px-4 py-3">
        <h2 className="font-semibold text-slate-800">Info penting</h2>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          {guide.infos.map((x) => (
            <div key={x.title} className="flex gap-3">
              <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-amber-100 text-amber-800"><GuideIco name={x.icon} size={20} /></span>
              <div className="min-w-0 text-sm leading-relaxed text-slate-700">
                <div className="font-semibold text-slate-900">{x.title}</div>
                <Rich text={x.text} wa={wa} btn={BTN} />
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
