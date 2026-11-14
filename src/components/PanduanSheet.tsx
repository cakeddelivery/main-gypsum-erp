import type { Letterhead } from "@/lib/letterhead";
import { fillWa, richParts, type Guide, type GuideIcon } from "@/lib/panduan";
import { DocSheet } from "./DocSheet";

/** Lebar lembar = A4 tegak; diunduh 2× (pixelRatio 2) → 2480 × 3508 px (300 dpi) */
export const PANDUAN_W = 1240;
export const PANDUAN_H = 1754;

const PATHS: Record<GuideIcon, React.ReactNode> = {
  login: <><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" /><path d="M10 17l5-5-5-5" /><path d="M15 12H3" /></>,
  pin: <><path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12Z" /><circle cx="12" cy="10" r="2.6" /></>,
  work: <><path d="M3 7h18v13H3z" /><path d="M8 7V4h8v3" /><path d="M3 12h18" /></>,
  report: <><path d="M6 3h9l4 4v14H6z" /><path d="M14 3v5h5" /><path d="M9 13h7M9 17h5" /></>,
  home: <><path d="M3 11l9-7 9 7" /><path d="M5 10v10h14V10" /><path d="M10 20v-6h4v6" /></>,
  key: <><circle cx="8" cy="15" r="4" /><path d="M11 12l9-9M17 6l3 3M15 8l2 2" /></>,
  mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></>,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" /></>,
  lock: <><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
  help: <><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7" /><path d="M12 17h.01" /></>,
  eye: <><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></>,
  stock: <><path d="M21 8l-9-5-9 5 9 5 9-5Z" /><path d="M3 8v8l9 5 9-5V8" /><path d="M12 13v8" /></>,
  truck: <><path d="M3 6h11v10H3z" /><path d="M14 9h4l3 3v4h-7" /><circle cx="7" cy="17.5" r="1.8" /><circle cx="17" cy="17.5" r="1.8" /></>,
  money: <><rect x="2" y="6" width="20" height="12" rx="2" /><circle cx="12" cy="12" r="3" /><path d="M6 9v.01M18 15v.01" /></>,
  wallet: <><path d="M3 7a2 2 0 0 1 2-2h13v4" /><path d="M3 7v11a2 2 0 0 0 2 2h15V9H5a2 2 0 0 1-2-2Z" /><path d="M16 14h.01" /></>,
  check: <><circle cx="12" cy="12" r="9" /><path d="M8 12.5l2.8 2.8L16.5 9" /></>,
  cog: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" /></>,
  tag: <><path d="M3 12V3h9l9 9-9 9-9-9Z" /><circle cx="7.5" cy="7.5" r="1.5" /></>,
  book: <><path d="M4 4h11a3 3 0 0 1 3 3v13H7a3 3 0 0 1-3-3z" /><path d="M4 17a3 3 0 0 1 3-3h11" /></>,
  alert: <><path d="M12 3l10 18H2L12 3Z" /><path d="M12 10v5M12 18h.01" /></>,
};

export function GuideIco({ name, size = 30 }: { name: GuideIcon; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {PATHS[name]}
    </svg>
  );
}

/** Teks bertanda: «Tombol» jadi label tombol (sama seperti di aplikasi), **tebal** */
export function Rich({ text, wa, btn }: { text: string; wa: string; btn: string }) {
  return (
    <>
      {richParts(fillWa(text, wa)).map((p, i) =>
        p.t === "btn" ? <b key={i} className={btn}>{p.v}</b> : p.t === "b" ? <b key={i}>{p.v}</b> : <span key={i}>{p.v}</span>,
      )}
    </>
  );
}

const SHEET_BTN = "whitespace-nowrap rounded-md border border-[#c7d7f5] bg-[#eef3fd] px-1.5 font-semibold text-[#1e3a8a]";

/**
 * Lembar Panduan A4 (divisi atau role): alur harian bernomor + tugas berkala + info penting, dengan kop surat.
 * `shots` = gambar layar asli yang tersedia (nama → URL), ditampilkan di samping langkah yang punya `shot`.
 */
export function PanduanSheet({ id, guide, lh, date, shots = {}, page }: { id: string; guide: Guide; lh: Letterhead; date: string; shots?: Record<string, string>; page?: string }) {
  const wa = lh.phone;
  return (
    <div className="panduan">
      <DocSheet
        id={id} lh={lh} exportWidth={PANDUAN_W} eyebrow="Panduan penggunaan ERP" title={guide.title}
        subtitle={guide.subtitle} meta={{ label: "Untuk", value: guide.audience }} signer="Manajemen" signDate={date}
      >
        <div className="text-[#0f172a]">
          <ol className="relative grid gap-2.5">
            <span className="absolute bottom-10 left-[30px] top-10 w-0.5 rounded bg-[#e2e8f0]" aria-hidden />
            {guide.phases.map((ph, n) => {
              const shot = ph.shot ? shots[ph.shot] : undefined;
              return (
                <li key={n} className="relative flex gap-4">
                  <div className="z-10 flex w-[62px] shrink-0 flex-col items-center">
                    <span className="grid h-[62px] w-[62px] place-items-center rounded-full text-[#ffffff] shadow" style={{ background: ph.color }}>
                      <GuideIco name={ph.icon} size={30} />
                    </span>
                  </div>
                  <div className="flex min-w-0 flex-1 gap-4 rounded-2xl border border-l-[6px] bg-[#ffffff] px-5 py-2.5 shadow-[0_1px_2px_rgba(15,23,42,0.06)]" style={{ borderColor: "#e2e8f0", borderLeftColor: ph.color }}>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-3">
                        <span className="text-[27px] font-extrabold leading-tight" style={{ color: ph.color }}>{n + 1}. {ph.title}</span>
                        <span className="rounded-full px-3 py-0.5 text-[14px] font-bold uppercase tracking-wide" style={{ background: ph.soft, color: ph.color }}>{ph.when}</span>
                      </div>
                      <ul className="mt-1 list-disc space-y-1 pl-6 text-[19px] leading-[1.4] text-[#334155] marker:text-[#94a3b8]">
                        {ph.items.slice(0, 1).map((t, i) => <li key={i}><Rich text={t} wa={wa} btn={SHEET_BTN} /></li>)}
                        {ph.flow && (
                          <li className="list-none">
                            <div className="-ml-6 my-1 flex flex-wrap items-center gap-1.5">
                              {ph.flow.map((s, i) => (
                                <span key={s} className="flex items-center gap-1.5">
                                  <span className="rounded-full px-2.5 py-0.5 text-[16px] font-semibold" style={{ background: ph.soft, color: ph.color }}>{i + 1}. {s}</span>
                                  {i < ph.flow!.length - 1 && <span className="text-[18px] text-[#94a3b8]">→</span>}
                                </span>
                              ))}
                            </div>
                          </li>
                        )}
                        {ph.items.slice(1).map((t, i) => <li key={i + 1}><Rich text={t} wa={wa} btn={SHEET_BTN} /></li>)}
                      </ul>
                    </div>
                    {shot && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={shot} alt="" className="my-1 w-[230px] shrink-0 self-center rounded-xl border border-[#e2e8f0] bg-[#ffffff] shadow-[0_2px_6px_rgba(15,23,42,0.08)]" />
                    )}
                  </div>
                </li>
              );
            })}
          </ol>

          {guide.periodic && (
            <div className="mt-3 rounded-2xl border border-[#e2e8f0] bg-[#f8fafc] px-5 py-2.5">
              <div className="text-[22px] font-extrabold text-[#334155]">Tugas mingguan / bulanan</div>
              <ul className="mt-1 list-disc space-y-1 pl-6 text-[18px] leading-[1.45] text-[#334155] marker:text-[#94a3b8]">
                {guide.periodic.map((t, i) => <li key={i}><Rich text={t} wa={wa} btn={SHEET_BTN} /></li>)}
              </ul>
            </div>
          )}

          <div className="mt-3 rounded-2xl border border-[#fde68a] bg-[#fffbeb] px-5 py-3">
            <div className="mb-1.5 text-[24px] font-extrabold text-[#92400e]">Info penting</div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-2">
              {guide.infos.map((x) => (
                <div key={x.title} className="flex gap-3">
                  <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[#fde68a] text-[#92400e]"><GuideIco name={x.icon} size={22} /></span>
                  <div className="min-w-0 text-[16.5px] leading-[1.45]">
                    <div className="text-[17.5px] font-bold text-[#0f172a]">{x.title}</div>
                    <div className="text-[#334155]"><Rich text={x.text} wa={wa} btn={SHEET_BTN} /></div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </DocSheet>
      {page && <div className="panduan-page">{page}</div>}
    </div>
  );
}
