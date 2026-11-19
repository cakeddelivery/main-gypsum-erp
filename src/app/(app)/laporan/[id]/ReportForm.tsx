"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ActionForm, Submit } from "@/components/ActionForm";
import { markInvalid } from "@/components/FormFeedback";
import { useCloseGuard, useCloseModal } from "@/components/Modal";
import { celebrate } from "@/components/Celebrate";
import { toast } from "@/components/Toaster";
import { ProofPreview } from "@/components/ProofPreview";
import {
  TEMPLATES,
  colTotals,
  countValues,
  gridRows,
  isDone,
  needsOrder,
  rowTotal,
  sectionFieldValues,
  sectionFilled,
  sectionTotal,
  catalogLines,
  MIX_BEBAS_KEY,
  VARIANTS,
  type CatalogLine,
  type ReportCatalogs,
  type ChecklistEntry,
  type GridRow,
  type GridSection,
  type ReportTemplate,
  type StockCountRow,
  type WorkData,
} from "@/lib/shiftReport";
import { addReceipts, removeChecklistPhoto, removeReceipt, saveReport, uploadChecklistPhoto } from "../actions";
import { FormDraft, clearFormDraft } from "@/components/FormDraft";
import { CameraCapture } from "@/components/CameraCapture";
import { readReopen, reportReopenKey, writeReopen } from "@/lib/reopen";
import { setUploading } from "@/lib/appVersion";
import { lpgFlow } from "@/lib/lpgShared";

/** Baris pesanan yang sedang dikirim (Stok → Pembelian) untuk barang divisi ini */
export type OrderOption = { lineId: string; itemId: string; label: string; remaining: number; cod: boolean; vendor: string; itemName: string; unit: string };
export type ReceiptView = { id: string; number: string; itemName: string; unit: string; qty: number; supplierName: string | null; hasPhoto: boolean; linked: boolean };
/** Barang tahap "Stok jadi": `group` produk induk, `sub` paket (baris katalog), `col` series (kolom katalog) */
export type ResultCountRow = { key: string; label: string; unit: string; qty: number | null; group?: string; sub?: string; col?: string };

type Props = {
  id: string;
  template: ReportTemplate | null;
  picName: string;
  work: WorkData;
  checklist: ChecklistEntry[];
  stock: StockCountRow[];
  people: string[];
  complaints: string;
  followUp: string;
  followUpStatus: string;
  /** Barang masuk hari ini (supplier/toko) + bahan divisi yang bisa dipilih */
  receipts: ReceiptView[];
  materials: { id: string; name: string; unit: string }[];
  /** Pesanan dalam pengiriman (hanya untuk yang boleh Terima barang) + rekening untuk COD */
  orders: OrderOption[];
  banks: { id: string; name: string }[];
  /** Laporan sudah dikirim (stok akhir tercatat): barang masuk lama tidak bisa dihapus */
  applied: boolean;
  /** Stok akhir hasil (patung kering / produk jadi per karakter) */
  resultTitle: string | null;
  resultCount: ResultCountRow[];
  /** SKU katalog untuk bagian isian katalog (Giftbox, Paket & Satuan Single Pack) */
  catalogs: ReportCatalogs;
  /** Giftbox Mix: karakter patung ke-5 bawaan (stok terbanyak) */
  mixDefault?: string | null;
  /** Hasil kerja yang masuk stok saat dikirim (kosong bila fitur mati) */
  flow: string[] | null;
  /** Laporan sudah pernah dikirim (kirim ulang = revisi) */
  sent: boolean;
  /** LPG tabung 5 kg (hanya format Produksi/Oven): isian tersimpan, status shift sebelumnya (prefill), total aset */
  lpg: { cur: { penuh: number; aktif: number; kosong: number; isiUlang: number } | null; prev: { penuh: number; aktif: number; kosong: number } | null; total: number } | null;
};

type Step = { key: string; label: string };

const fmt = (v: number) => v.toLocaleString("id-ID");
const toNum = (s: string) => (s.trim() === "" ? null : Math.max(0, Math.round(Number(s.replace(/\./g, "").replace(/,/g, ".")) || 0)));

/** Perkecil foto di HP sebelum diunggah (maks. 1600 px, JPEG) agar cepat & hemat kuota */
export function ReportForm(p: Props) {
  const t = p.template ? TEMPLATES[p.template] : null;
  const [work, setWork] = useState<WorkData>(() => {
    if (!t) return {};
    const w: WorkData = { ...p.work };
    // Baris nama orang diisi otomatis dari karyawan divisi bila laporan masih kosong
    for (const s of t.sections) if (s.kind === "grid" && !s.legacy && s.rows === "people" && !gridRows(w, s).length) w[s.key] = (p.people.length ? p.people : [""]).map((name) => ({ name, v: [] }));
    return w;
  });
  const [stock, setStock] = useState(p.stock);
  // LPG: isian laporan ini, atau diisi dulu dari status shift sebelumnya (tinggal ubah yang berbeda)
  const [lpg, setLpg] = useState(() => {
    const b = p.lpg?.cur ?? (p.lpg?.prev ? { ...p.lpg.prev, isiUlang: 0 } : null);
    return { penuh: b ? String(b.penuh) : "", aktif: b ? String(b.aktif) : "", kosong: b ? String(b.kosong) : "", isiUlang: b ? String(b.isiUlang) : "0" };
  });
  const [checks, setChecks] = useState(() => p.checklist.map((c) => c.done));

  const setGrid = (s: GridSection, rows: GridRow[]) => setWork((w) => ({ ...w, [s.key]: rows }));
  const order = stock.filter(needsOrder);
  const doneCount = p.checklist.filter((c, i) => (c.photo ? !!c.photoPath : checks[i])).length;

  const hasWork = !!(t && t.sections.some((s) => !(s.kind === "grid" && s.legacy) || gridRows(p.work, s as GridSection).length > 0));
  // Langkah (stepper): bagian yang tidak tampil tetap ada di form (disembunyikan) sehingga ikut tersimpan
  const steps: Step[] = [
    // PIC tidak ditampilkan (diisi otomatis di server dari akun pengirim); tahap hasil kerja hanya bila divisi punya isiannya
    ...(hasWork ? [{ key: "hasil", label: "Hasil kerja" }] : []),
    { key: "checklist", label: "Checklist" },
    ...(p.resultTitle && p.resultCount.length > 0 ? [{ key: "hasilakhir", label: "Stok jadi" }] : []),
    ...(stock.length > 0 ? [{ key: "stok", label: "Stok akhir" }] : []),
    ...(p.lpg ? [{ key: "lpg", label: "LPG" }] : []),
    { key: "catatan", label: "Catatan & kirim" },
  ];
  // Halaman sempat dimuat ulang (mis. HP menutup browser saat kamera dibuka): lanjut di langkah terakhir
  const reopenKey = reportReopenKey(p.id);
  const [step, setStep] = useState(() => {
    if (typeof window === "undefined") return 0;
    const i = steps.findIndex((x) => x.key === readReopen(reopenKey)?.step);
    return i < 0 ? 0 : i;
  });
  const [seen, setSeen] = useState(() => new Set([0, step]));
  const cur = steps[Math.min(step, steps.length - 1)].key;
  const last = step >= steps.length - 1;
  const close = useCloseModal();
  const formRef = useRef<HTMLDivElement>(null);
  const draftKey = `mg_draf_laporan_${p.id}`;
  const bodyTop = useRef<HTMLElement>(null);
  const go = (i: number) => {
    setStep(i);
    setSeen((x) => new Set(x).add(i));
  };
  // Ingat langkah aktif; setelah muat ulang gulir ke item checklist terakhir yang sedang difoto
  useEffect(() => {
    writeReopen(reopenKey, { step: steps[step]?.key });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);
  useEffect(() => {
    const item = readReopen(reopenKey)?.item;
    if (item == null) return;
    writeReopen(reopenKey, { item: undefined });
    const t = window.setTimeout(() => {
      const el = formRef.current?.querySelector<HTMLElement>(`[data-check-item="${item}"]`);
      if (!el) return;
      el.scrollIntoView({ block: "center" });
      el.classList.add("ring-2", "ring-brand-400");
      window.setTimeout(() => el.classList.remove("ring-2", "ring-brand-400"), 2500);
      toast("Lanjut dari foto checklist terakhir");
    }, 500);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Pindah langkah → kembali ke atas popup
  useEffect(() => {
    const body = bodyTop.current?.closest(".modal-body");
    if (body) body.scrollTop = 0;
    bodyTop.current?.querySelector('[aria-current="step"]')?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [step]);
  // Penilaian harian divisi dari checklist (dipakai di langkah terakhir & konfirmasi kirim)
  const missingPhoto = p.checklist.filter((c) => c.photo && !c.photoPath);
  const unchecked = p.checklist.filter((c, i) => !c.photo && !checks[i]);
  const score = p.checklist.length ? Math.round((doneCount / p.checklist.length) * 100) : 100;
  const [confirming, setConfirming] = useState(false);
  const sending = useRef(false);
  const router = useRouter();
  const trySend = () => {
    if (missingPhoto.length) {
      toast(`Lampirkan foto dulu: ${missingPhoto.map((c) => c.label).join(", ")}`, false);
      go(steps.findIndex((x) => x.key === "checklist"));
      return;
    }
    setConfirming(true);
  };
  // Tahap "Stok jadi": nilai terkontrol (untuk jumlah terisi), dikelompokkan per produk induk + kotak cari
  const [rc, setRc] = useState<Record<string, string>>(() => Object.fromEntries(p.resultCount.map((r) => [r.key, r.qty == null ? "" : String(r.qty)])));
  const rcFilled = Object.values(rc).filter((v) => v !== "").length;
  const [rcQuery, setRcQuery] = useState("");
  // Cari per kata (mis. "24 cewek" cocok dengan "Paket Single Pack 24 pcs · Cewek")
  const matches = (label: string) => rcQuery.trim().toLowerCase().split(/\s+/).every((w) => label.toLowerCase().includes(w));
  const rcGroups = Object.entries(
    p.resultCount.reduce<Record<string, ResultCountRow[]>>((m, r) => ((m[r.group ?? "Lainnya"] ??= []).push(r), m), {}),
  );
  // Tutup (✕ di bawah atau di judul popup): konfirmasi simpan draf / buang perubahan bila ada isian berubah
  const [dirty, setDirty] = useState(false);
  const [closeAsk, setCloseAsk] = useState(false);
  // Tombol ✕: selalu konfirmasi dulu (isian yang belum disimpan bisa hilang); setelah ditutup kembali ke daftar Laporan
  const askClose = () => setCloseAsk(true);
  const leaving = useRef(false);
  const leave = () => {
    close();
    router.push("/laporan");
  };
  const setGuard = useCloseGuard();
  useEffect(() => {
    setGuard(askClose);
    return () => setGuard(null);
  });
  // Kolom wajib yang kosong di langkah lain: buka langkahnya lalu gulir & fokus ke kolom itu
  useEffect(() => {
    const el = formRef.current;
    if (!el) return;
    // FormFeedback/ActionForm mengirim "field-reveal" dari kolom yang salah (validasi HP maupun penolakan server)
    const onReveal = (e: Event) => {
      const box = (e.target as HTMLElement).closest<HTMLElement>("[data-step]");
      const i = steps.findIndex((x) => x.key === box?.dataset.step);
      if (i < 0 || steps[i].key === cur) return;
      go(i);
    };
    el.addEventListener("field-reveal", onReveal);
    return () => el.removeEventListener("field-reveal", onReveal);
  });
  const show = (key: string) => (key === cur ? "" : "hidden");

  return (
    <div ref={formRef} onInput={() => setDirty(true)} onChange={() => setDirty(true)}>
      {/* Cadangan isian di HP: dipulihkan bila halaman dimuat ulang (mis. saat kamera foto checklist dibuka) */}
      <FormDraft storageKey={draftKey} target={formRef} />
      <nav ref={bodyTop} aria-label="Langkah laporan" className="sticky -top-4 z-10 -mx-5 -mt-4 mb-4 flex-none border-b border-slate-200 bg-white px-3 py-2">
        <ol className="flex gap-1 overflow-x-auto">
          {steps.map((x, i) => (
            <li key={x.key} className="shrink-0">
              <button type="button" onClick={() => go(i)} aria-current={i === step ? "step" : undefined} className={`flex min-h-10 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition ${i === step ? "bg-brand-600 text-white" : seen.has(i) ? "bg-brand-50 text-brand-700" : "bg-slate-100 text-slate-600"}`}>
                <span className={`grid h-5 w-5 place-items-center rounded-full text-[11px] ${i === step ? "bg-white/20" : "bg-white"}`}>{seen.has(i) && i !== step ? "✓" : i + 1}</span>
                {x.label}
              </button>
            </li>
          ))}
        </ol>
      </nav>
    <ActionForm
      action={async (prev, fd) => {
        const r = await saveReport(prev, fd);
        // Tersimpan di server: draf cadangan di HP tidak diperlukan lagi
        if (r.ok) clearFormDraft(draftKey);
        // Selebrasi dipicu langsung dari respons server: setelah terkirim, halaman mengunci laporan
        // (form bisa hilang sebelum efek onSuccess sempat berjalan)
        if (r.ok && fd.get("intent") === "send") {
          sending.current = false;
          celebrate("Laporan Berhasil Terkirim");
          router.replace(`/laporan/${p.id}?jpg=1`, { scroll: true });
        }
        return r;
      }}
      className="space-y-4"
      onSuccess={() => {
        setConfirming(false);
        setCloseAsk(false);
        setDirty(false);
        window.setTimeout(leaving.current ? leave : close, 750);
        leaving.current = false;
      }}
      onError={(err) => {
        if (!sending.current) return;
        sending.current = false;
        setConfirming(false);
        toast(err, false);
      }}
    >
      <input type="hidden" name="id" value={p.id} />

      {hasWork && (
        <section data-step="hasil" className={`card space-y-4 p-4 ${show("hasil")}`}>
          <h3 className="font-semibold text-slate-800">Detail hasil kerja</h3>
          {t.sections.map((s) => {
            if (s.kind === "grid" && s.legacy && !gridRows(p.work, s).some((r) => r.v.some((v) => v != null))) return null;
            if (s.kind === "grid") {
              const people = s.rows === "people";
              const rows = people ? ((work[s.key] as GridRow[] | undefined) ?? []) : gridRows(work, s);
              const update = (ri: number, patch: Partial<GridRow>) => setGrid(s, rows.map((r, i) => (i === ri ? { ...r, ...patch } : r)));
              return (
                <div key={s.key}>
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-slate-700">{s.title}</span>
                    <span className="text-xs text-slate-500">{s.totalLabel}: <b className="text-slate-800">{fmt(rows.reduce((a, r) => a + rowTotal(r), 0))} pcs</b></span>
                  </div>
                  <input type="hidden" name={`w.${s.key}.n`} value={rows.length} />
                  <div className="space-y-2">
                    {rows.map((r, ri) => (
                      <div key={ri} className="rounded-lg border border-slate-200 p-2">
                        <div className="mb-1.5 flex items-center gap-2">
                          {people ? (
                            <input name={`w.${s.key}.${ri}.name`} value={r.name} onChange={(e) => update(ri, { name: e.target.value })} placeholder="Nama" className="input py-1.5" />
                          ) : (
                            <span className="text-sm font-medium">{r.name}</span>
                          )}
                          {s.cols.length > 1 && <span className="ml-auto whitespace-nowrap text-xs text-slate-500">Total {fmt(rowTotal(r))}</span>}
                          {people && (
                            <button type="button" aria-label="Hapus baris" className="btn-secondary btn-sm shrink-0" onClick={() => setGrid(s, rows.filter((_, i) => i !== ri))}>✕</button>
                          )}
                        </div>
                        <div className={`keep-cols grid gap-2 ${s.cols.length > 1 ? "grid-cols-2 sm:grid-cols-4" : "grid-cols-1"}`}>
                          {s.cols.map((c, ci) => (
                            <label key={c} className="block">
                              {s.cols.length > 1 && <span className="text-xs text-slate-500">{c}</span>}
                              <input
                                name={`w.${s.key}.${ri}.${ci}`}
                                inputMode="numeric"
                                value={r.v[ci] ?? ""}
                                onChange={(e) => { const v = [...r.v]; v[ci] = toNum(e.target.value); update(ri, { v }); }}
                                placeholder={s.cols.length > 1 ? "—" : "pcs"}
                                className="input py-1.5"
                              />
                            </label>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                  {people && <button type="button" className="btn-secondary btn-sm mt-2" onClick={() => setGrid(s, [...rows, { name: "", v: [] }])}>+ Tambah orang</button>}
                  {s.colTotals && rows.length > 0 && (
                    <div className="mt-2 text-xs text-slate-500">Total: {colTotals(rows, s.cols.length).map((v, i) => `${s.cols[i]} ${fmt(v)}`).join(" · ")}</div>
                  )}
                </div>
              );
            }
            if (s.kind === "catalog") {
              const g = p.catalogs[s.key];
              const lines = catalogLines(work, s.key);
              const qtyOf = (id: string) => lines.find((l) => l.productId === id)?.qty ?? null;
              if (!g || !g.rows.length) {
                return <p key={s.key} className="rounded-lg bg-amber-50 p-2 text-xs text-amber-700"><b>{s.title}:</b> katalog produk induk &quot;{s.family}&quot; belum ada. Isi bagian lama di atas, atau minta admin mengisi Produk &amp; HPP → Produk Induk.</p>;
              }
              const setQty = (cell: NonNullable<(typeof g.rows)[number]["cells"][number]>, label: string, col: string, raw: string) => {
                const qty = toNum(raw);
                setWork((w) => {
                  const rest = catalogLines(w, s.key).filter((l) => l.productId !== cell.productId);
                  const next: CatalogLine[] = qty ? [...rest, { productId: cell.productId, sku: cell.sku, label, col, variant: cell.variant, patung: cell.patung, qty }] : rest;
                  return { ...w, [s.key]: next };
                });
              };
              const total = sectionTotal(t, work, s.key);
              const one = g.rows.length === 1;
              return (
                <div key={s.key}>
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-slate-700">{s.title} <span className="text-xs font-normal text-slate-500">(isi jumlah {s.qtyLabel})</span></span>
                    <span className="text-xs text-slate-500">{s.totalLabel}: <b className="text-slate-800">{fmt(total)} {s.unit}</b></span>
                  </div>
                  <div className="table-wrap">
                    <table className="tbl keep-cols text-sm">
                      <thead><tr>{!one && <th />}{g.cols.map((c) => <th key={c} className="text-center">{c}</th>)}</tr></thead>
                      <tbody>
                        {g.rows.map((r) => (
                          <tr key={r.label}>
                            {!one && <td className="whitespace-nowrap text-xs font-medium">{r.label}</td>}
                            {r.cells.map((c, ci) => (
                              <td key={ci} className="p-1">
                                {c ? (
                                  <input
                                    name={`w.${s.key}.${c.productId}`}
                                    inputMode="numeric"
                                    value={qtyOf(c.productId) ?? ""}
                                    onChange={(e) => setQty(c, [r.label, g.cols[ci]].filter(Boolean).join(" · "), g.cols[ci], e.target.value)}
                                    placeholder="—"
                                    aria-label={`${r.label} ${g.cols[ci]}`}
                                    className="input min-w-14 py-1.5 text-center"
                                  />
                                ) : null}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {p.template === "GIFTBOX" && lines.some((l) => l.variant === "MIX") && (
                    <label className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                      <span className="text-slate-700">Patung ke-5 Giftbox Mix (varian bebas)</span>
                      <select name={`w.${MIX_BEBAS_KEY}`} value={(work[MIX_BEBAS_KEY] as string | undefined) ?? p.mixDefault ?? VARIANTS[0]} onChange={(e) => setWork((w) => ({ ...w, [MIX_BEBAS_KEY]: e.target.value }))} className="input w-auto py-1.5">
                        {VARIANTS.map((v) => <option key={v} value={v}>{v}{v === p.mixDefault ? " (stok terbanyak)" : ""}</option>)}
                      </select>
                      <span className="w-full text-xs text-slate-500">Giftbox Mix = 1 patung tiap karakter + 1 patung karakter ini.</span>
                    </label>
                  )}
                </div>
              );
            }
            if (s.kind === "count" && s.replacedBy && p.catalogs[s.replacedBy]?.rows.length && !sectionFilled(t, p.work, s.key)) return null;
            if (s.kind === "count") {
              const v = countValues(work, s.key);
              return (
                <div key={s.key}>
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-slate-700">{s.title}</span>
                    <span className="text-xs text-slate-500">{s.totalLabel}: <b className="text-slate-800">{fmt(sectionTotal(t, work, s.key))} {s.unit ?? "pcs"}</b></span>
                  </div>
                  <div className="keep-cols grid grid-cols-2 gap-2 sm:grid-cols-5">
                    {s.fields.map((f) => (
                      <label key={f.key} className="block">
                        <span className="text-xs text-slate-500">{f.formLabel ?? f.label}</span>
                        <input
                          name={`w.${s.key}.${f.key}`}
                          inputMode="numeric"
                          value={v[f.key] ?? ""}
                          onChange={(e) => setWork((w) => ({ ...w, [s.key]: { ...countValues(w, s.key), [f.key]: toNum(e.target.value) } }))}
                          placeholder="—"
                          className="input py-1.5"
                        />
                      </label>
                    ))}
                  </div>
                </div>
              );
            }
            if (s.kind === "choice") {
              const v = typeof work[s.key] === "string" ? (work[s.key] as string) : "";
              const need = !!s.showIf && sectionTotal(t, work, s.showIf) > 0;
              if (s.showIf && !need && !v) return <input key={s.key} type="hidden" name={`w.${s.key}`} value="" />;
              return (
                <label key={s.key} className="block">
                  <span className="text-sm font-medium text-slate-700">{s.title}</span>
                  <select name={`w.${s.key}`} value={v} required={need} onChange={(e) => setWork((w) => ({ ...w, [s.key]: e.target.value }))} className="input mt-1">
                    <option value="">— pilih —</option>
                    {s.options.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                </label>
              );
            }
            return (
              <div key={s.key} className="rounded-lg bg-slate-50 p-2 text-xs text-slate-600">
                <b>{s.title} (otomatis{Array.isArray(s.from) ? ", dari jumlah patung per SKU" : ` ×${s.factor}`}):</b> {sectionFieldValues(t, work, s).map((f) => `${f.label} ${f.value ?? "—"}`).join(" · ") || "—"} · <b>{s.totalLabel} {fmt(sectionTotal(t, work, s.key))}</b>
              </div>
            );
          })}
        </section>
      )}

      <section data-step="checklist" className={`card p-4 ${show("checklist")}`}>
        <h3 className="mb-2 font-semibold text-slate-800">Checklist penutupan {doneCount}/{p.checklist.length}</h3>
        <ul className="space-y-2">
          {p.checklist.map((c, i) => (
            <li key={i} data-check-item={i} className={`flex items-center gap-3 rounded-lg border px-3 py-2 transition ${(c.photo ? c.photoPath : checks[i]) ? "border-emerald-200 bg-emerald-50" : "border-slate-200"}`}>
              {c.photo ? (
                <PhotoTask id={p.id} index={i} entry={c} />
              ) : (
                <label className="flex min-h-9 flex-1 items-center gap-3 text-sm">
                  <input type="checkbox" name={`check_${i}`} checked={checks[i]} onChange={(e) => setChecks((x) => x.map((v, j) => (j === i ? e.target.checked : v)))} className="h-5 w-5 shrink-0" />
                  {c.label}
                </label>
              )}
            </li>
          ))}
        </ul>
      </section>



      {p.resultTitle && p.resultCount.length > 0 && (
        <section data-step="hasilakhir" className={`card p-4 ${show("hasilakhir")}`}>
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <h3 className="font-semibold text-slate-800">{p.resultTitle}</h3>
            <span className="shrink-0 text-xs font-medium text-slate-500 tabular-nums">{rcFilled}/{p.resultCount.length} terisi</span>
          </div>
          <p className="mb-3 text-xs text-slate-500">Hitung fisik barang setengah jadi / produk jadi tanggung jawab divisi ini di gudang, setelah hasil kerja dihitung. Kosongkan bila tidak dihitung.</p>
          {p.resultCount.length > 12 && (
            <input type="search" value={rcQuery} onChange={(e) => setRcQuery(e.target.value)} placeholder="Cari barang…" aria-label="Cari barang" data-raw className="input mb-2 py-1.5" />
          )}
          <div className="space-y-2">
            {rcGroups.map(([g, rows]) => {
              const shown = rows.filter((r) => matches(r.label));
              const filled = rows.filter((r) => (rc[r.key] ?? "") !== "").length;
              return (
                <details key={g} open={rcGroups.length <= 2 || !!rcQuery} className={`group rounded-lg border border-slate-200 ${shown.length ? "" : "hidden"}`}>
                  <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-sm font-medium text-slate-700 [&::-webkit-details-marker]:hidden">
                    <span className="min-w-0">{g}</span>
                    <span className="flex shrink-0 items-center gap-2 text-xs text-slate-500 tabular-nums">{filled}/{rows.length}<span className="transition group-open:rotate-180" aria-hidden>▾</span></span>
                  </summary>
                  {rows.some((r) => r.col) ? (
                    // Produk induk: per paket (baris katalog), series dalam 2 kolom agar tidak banyak gulir
                    <div className="space-y-2 border-t border-slate-100 p-2">
                      {Object.entries(rows.reduce<Record<string, ResultCountRow[]>>((m, r) => ((m[r.sub ?? ""] ??= []).push(r), m), {})).map(([sub, cells]) => {
                        const vis = cells.filter((r) => matches(r.label));
                        const sum = cells.reduce((a, r) => a + (Number(rc[r.key]) || 0), 0);
                        return (
                          <div key={sub || "-"} className={`rounded-lg border border-slate-200 p-2.5 ${vis.length ? "" : "hidden"}`}>
                            {sub && (
                              <div className="mb-1.5 flex items-baseline justify-between gap-2">
                                <span className="text-sm font-semibold text-slate-800">{sub}</span>
                                <span className="text-xs text-slate-500 tabular-nums">{sum ? `${sum.toLocaleString("id-ID")} ${cells[0].unit}` : "—"}</span>
                              </div>
                            )}
                            <div className="keep-cols grid grid-cols-2 gap-2">
                              {cells.map((r) => (
                                <label key={r.key} className={`block min-w-0 ${matches(r.label) ? "" : "hidden"}`}>
                                  <span className="block break-words text-xs leading-tight text-slate-500">{r.col || r.label}</span>
                                  <input name={`rc.${r.key}`} inputMode="numeric" value={rc[r.key] ?? ""} onChange={(e) => setRc((x) => ({ ...x, [r.key]: e.target.value }))} className={`input py-1.5 text-right ${rc[r.key] ? "border-brand-400 bg-brand-50" : ""}`} placeholder="0" aria-label={r.label} />
                                </label>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <ul className="divide-y divide-slate-100 border-t border-slate-100 px-3">
                      {rows.map((r) => (
                        <CountRow
                          key={r.key}
                          hidden={!matches(r.label)}
                          name={r.label}
                          unit={r.unit}
                          inputName={`rc.${r.key}`}
                          inputMode="numeric"
                          value={rc[r.key] ?? ""}
                          onChange={(v) => setRc((x) => ({ ...x, [r.key]: v }))}
                        />
                      ))}
                    </ul>
                  )}
                </details>
              );
            })}
          </div>
        </section>
      )}

      {stock.length > 0 && (
        <section data-step="stok" className={`card p-4 ${show("stok")}`}>
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <h3 className="font-semibold text-slate-800">Stok akhir shift</h3>
            <span className="shrink-0 text-xs font-medium text-slate-500 tabular-nums">{stock.filter((x) => x.qty != null).length}/{stock.length} terisi</span>
          </div>
          <p className="mb-3 text-xs text-slate-500">Hitung fisik sisa bahan baku divisi. Bahan dengan stok ≤ limit otomatis masuk daftar order.</p>
          <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            {p.receipts.length > 0 ? <>✓ {p.receipts.length} barang masuk hari ini sudah dicatat. </> : null}
            Ada barang datang dari supplier/toko? Catat dulu lewat tombol <b>+ Barang masuk</b> (di luar form ini) <b>sebelum</b> menghitung stok akhir, agar tidak dobel.
          </p>
          <ul className="divide-y divide-slate-100">
            {stock.map((row, i) => {
              const low = needsOrder(row);
              return (
                <CountRow
                  key={row.itemId}
                  name={<>{low && "⚠ "}{row.name}</>}
                  warn={low}
                  sub={`limit ${fmt(row.limit)} ${row.unit}`}
                  unit={row.unit}
                  inputName={`s.${row.itemId}`}
                  inputMode="decimal"
                  value={row.qty == null ? "" : String(row.qty)}
                  onChange={(v) => { const t = v.trim(); const q = t === "" ? null : Math.max(0, Number(t.replace(",", ".")) || 0); setStock((x) => x.map((r, j) => (j === i ? { ...r, qty: q } : r))); }}
                />
              );
            })}
          </ul>
          {order.length > 0 && (
            <div className="mt-3 rounded-lg bg-rose-50 p-3 text-sm text-rose-700">
              <div className="mb-1 font-semibold">Order bahan baku ({order.length})</div>
              <ul className="space-y-0.5">{order.map((o) => <li key={o.itemId}>⚠ {o.name} — stok {fmt(o.qty!)} · limit {fmt(o.limit)} {o.unit}</li>)}</ul>
            </div>
          )}
        </section>
      )}

      {p.lpg && (() => {
        const n = (v: string) => (v.trim() === "" ? NaN : Number(v));
        const cur = { penuh: n(lpg.penuh), aktif: n(lpg.aktif), kosong: n(lpg.kosong), isiUlang: Number(lpg.isiUlang) || 0 };
        const ok = [cur.penuh, cur.aktif, cur.kosong].every((x) => Number.isInteger(x));
        const total = cur.penuh + cur.aktif + cur.kosong;
        const flow = ok ? lpgFlow(p.lpg!.prev, cur) : null;
        const field = (key: "penuh" | "aktif" | "kosong" | "isiUlang", label: string, hint: string) => (
          <label className="block">
            <span className="label">{label}</span>
            <input name={`lpg.${key}`} inputMode="numeric" value={lpg[key]} onChange={(e) => setLpg((x) => ({ ...x, [key]: e.target.value.replace(/\D/g, "") }))} className="input py-3 text-center text-2xl font-bold tabular-nums" placeholder="0" aria-label={label} />
            <span className="mt-0.5 block text-center text-xs text-slate-500">{hint}</span>
          </label>
        );
        return (
          <section data-step="lpg" className={`card space-y-3 p-4 ${show("lpg")}`}>
            <input type="hidden" name="lpg.present" value="1" />
            <h3 className="font-semibold text-slate-800">LPG tabung 5 kg</h3>
            <p className="text-xs text-slate-500">Hitung tabung sekarang. Angka sudah diisi dari shift sebelumnya, ubah yang berbeda saja.</p>
            <div className="grid grid-cols-3 gap-2">
              {field("penuh", "Penuh", "cadangan")}
              {field("aktif", "Aktif", "terpasang")}
              {field("kosong", "Kosong", "tunggu isi ulang")}
            </div>
            {field("isiUlang", "Isi ulang diterima shift ini", "tabung kosong yang kembali penuh")}
            {ok && total !== p.lpg.total && <p role="alert" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">Total {total} tabung, seharusnya {p.lpg.total}. Periksa lagi (tabung hilang/bertambah akan diberi tanda).</p>}
            {flow && p.lpg.prev && <p className={`rounded-lg px-3 py-2 text-sm ${flow.valid ? "bg-sky-50 text-sky-800" : "bg-amber-50 text-amber-800"}`}>{flow.valid ? `Dipasang ${flow.dipasang} · tabung habis ${flow.habis} sejak laporan sebelumnya.` : "Angka tidak masuk akal dibanding laporan sebelumnya. Periksa jumlah penuh/aktif/kosong dan isi ulang."}</p>}
          </section>
        );
      })()}

      <section data-step="catatan" className={`card space-y-3 p-4 ${show("catatan")}`}>
        <label className="block"><span className="label">Catatan / kendala (opsional)</span><textarea name="complaints" defaultValue={p.complaints} className="input" rows={3} /></label>
        <p className="text-xs text-slate-500">Bila ada kendala, Supervisor, Finance, dan Owner mendapat peringatan untuk menindaklanjuti.</p>
      </section>
      <section data-step="catatan" className={`card p-4 ${show("catatan")}`}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold text-slate-800">Penilaian harian divisi</h3>
            <p className="text-xs text-slate-500">Dari checklist penutupan: {doneCount}/{p.checklist.length} selesai</p>
          </div>
          <span className={`text-2xl font-bold tabular-nums ${score >= 90 ? "text-emerald-600" : score >= 70 ? "text-amber-600" : "text-rose-600"}`}>{score}</span>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100"><div className={`h-full rounded-full transition-all ${score >= 90 ? "bg-emerald-500" : score >= 70 ? "bg-amber-500" : "bg-rose-500"}`} style={{ width: `${score}%` }} /></div>
        {missingPhoto.length > 0 && <p className="mt-2 text-xs font-medium text-rose-600">⚠ Foto wajib belum dilampirkan: {missingPhoto.map((c) => c.label).join(", ")}. Laporan belum bisa dikirim.</p>}
        {missingPhoto.length === 0 && unchecked.length > 0 && <p className="mt-2 text-xs text-amber-700">{unchecked.length} checklist belum dicentang dan akan mengurangi nilai.</p>}
      </section>
      {p.flow && (
        <section data-step="catatan" className={`rounded-lg bg-slate-50 p-3 text-sm ${show("catatan")}`}>
          <div className="mb-1 font-medium text-slate-700">Hasil kerja masuk stok saat dikirim{p.sent ? " (posting lama dibatalkan dulu)" : ""}:</div>
          {p.flow.length ? <ul className="space-y-0.5 text-slate-600">{p.flow.map((l) => <li key={l}>{l}</li>)}</ul> : <p className="text-slate-500">Tidak ada (hasil kerja kosong)</p>}
        </section>
      )}
      <p data-step="catatan" className={`text-xs text-slate-500 ${show("catatan")}`}>
        Saat dikirim, laporan diteruskan ke penerima rekap di Telegram (bila bot aktif) dan stok akhir shift dicatat sebagai stock opname bahan baku divisi.
      </p>
      {/* Tombol selalu terlihat di bawah popup */}
      <div className="modal-foot">
        <button type="button" className="btn-secondary flex-1" disabled={step === 0} onClick={() => go(step - 1)}>‹ Kembali</button>
        {last ? (
          <button type="button" className="btn-success flex-1" onClick={trySend}>{p.sent ? "Kirim ulang" : "Kirim laporan"}</button>
        ) : (
          <button type="button" className="btn-primary flex-1" onClick={() => go(step + 1)}>Berikutnya ›</button>
        )}
      </div>
      {/* Tutup laporan: simpan draf dulu atau buang perubahan */}
      {closeAsk && (
        <div role="alertdialog" aria-labelledby="tutup-lap-judul" className="anim-fade fixed inset-0 z-30 grid place-items-center bg-slate-900/50 p-4">
          <div className="anim-pop w-full max-w-sm rounded-xl border border-slate-300 bg-white p-4 shadow-2xl">
            <p id="tutup-lap-judul" className="font-semibold text-slate-900">Tutup laporan?</p>
            <p className="mt-1 text-sm text-slate-600">{dirty ? "Ada isian yang belum disimpan dan akan hilang bila ditutup." : "Isian yang belum disimpan akan hilang bila ditutup."} Simpan sebagai draf agar bisa dilanjutkan nanti.</p>
            <div className="mt-4 grid gap-2">
              <span className="flex" onClickCapture={() => { sending.current = false; leaving.current = true; }}>
                <Submit className="btn-primary flex-1" name="intent" value="draft" pendingText="Menyimpan…">Simpan draf</Submit>
              </span>
              <button type="button" className="btn-danger" onClick={() => { clearFormDraft(draftKey); setCloseAsk(false); leave(); }}>Tutup tanpa simpan</button>
              <button type="button" className="btn-secondary" onClick={() => setCloseAsk(false)} autoFocus>Batal</button>
            </div>
          </div>
        </div>
      )}
      {/* Konfirmasi kirim: nilai checklist + daftar yang belum dicentang */}
      {confirming && (
        <div role="alertdialog" aria-labelledby="kirim-judul" className="anim-fade fixed inset-0 z-30 grid place-items-center bg-slate-900/50 p-4">
          <div className="anim-pop w-full max-w-sm rounded-xl border border-slate-300 bg-white p-4 shadow-2xl">
            <p id="kirim-judul" className="font-semibold text-slate-900">Kirim laporan sekarang?</p>
            <p className="mt-1 text-sm text-slate-600">Nilai checklist hari ini: <b className={score >= 90 ? "text-emerald-600" : score >= 70 ? "text-amber-600" : "text-rose-600"}>{score}</b> ({doneCount}/{p.checklist.length})</p>
            {unchecked.length > 0 && (
              <div className="mt-2 rounded-lg bg-amber-50 p-2 text-sm text-amber-800">
                <p className="font-medium">{unchecked.length} checklist belum dicentang:</p>
                <ul className="mt-1 list-disc pl-5 text-xs">{unchecked.map((c) => <li key={c.label}>{c.label}</li>)}</ul>
              </div>
            )}
            <p className="mt-2 text-xs text-slate-500">Stok akhir shift akan menjadi stok sistem (stock opname). {reportLockNote}</p>
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button type="button" className="btn-secondary" onClick={() => { setConfirming(false); if (unchecked.length) go(steps.findIndex((x) => x.key === "checklist")); }}>{unchecked.length ? "Lengkapi checklist" : "Batal"}</button>
              <span onClickCapture={() => (sending.current = true)}>
                <Submit className="btn-success" name="intent" value="send" pendingText="Mengirim…">Ya, kirim</Submit>
              </span>
            </div>
          </div>
        </div>
      )}
    </ActionForm>
    </div>
  );
}

const reportLockNote = "Setelah terkirim, anggota tidak bisa mengubah laporan.";



type ReceiptRow = { key: number; itemId: string; qty: string; orderLine: string; shop: string };
let rowSeq = 0;
const newRow = (): ReceiptRow => ({ key: ++rowSeq, itemId: "", qty: "", orderLine: "", shop: "" });

/**
 * Barang masuk hari ini: banyak baris sekaligus (+ Tambah barang, hapus baris, satu tombol Simpan semua).
 * Pilihan barang hanya bahan milik divisi laporan (bisa diketik untuk mencari). Satu foto nota opsional per simpan.
 */
export function ReceiptSection({ id, receipts, materials, applied, orders, banks }: { id: string; receipts: ReceiptView[]; materials: { id: string; name: string; unit: string }[]; applied: boolean; orders: OrderOption[]; banks: { id: string; name: string }[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<ReceiptRow[]>(() => [newRow()]);
  const [photo, setPhoto] = useState<{ blob: Blob; url: string } | null>(null);
  const [cam, setCam] = useState(false);
  const [bank, setBank] = useState(banks[0]?.id ?? "");
  const orderOf = (r: ReceiptRow) => orders.find((o) => o.lineId === r.orderLine);
  const anyCod = rows.some((r) => orderOf(r)?.cod);
  const patch = (key: number, p: Partial<ReceiptRow>) => setRows((xs) => xs.map((x) => (x.key === key ? { ...x, ...p } : x)));
  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>, ok: string) => {
    setBusy(true);
    try {
      const r = await fn();
      if (!r.ok) throw new Error(r.error);
      toast(ok);
      router.refresh();
      return true;
    } catch (e) {
      toast(e instanceof Error ? e.message : "Gagal", false);
      return false;
    } finally {
      setBusy(false);
    }
  };
  // Rekomendasi pesanan: ketuk untuk mengisi baris kosong (atau menambah baris baru)
  const toggleOrder = (o: OrderOption) => {
    const on = rows.find((r) => r.orderLine === o.lineId);
    if (on) return setRows((xs) => (xs.length > 1 ? xs.filter((x) => x.key !== on.key) : [newRow()]));
    const fill = { itemId: o.itemId, orderLine: o.lineId, shop: o.vendor, qty: String(o.remaining).replace(".", ",") };
    const empty = rows.find((r) => !r.itemId && !(qtyOf(r) > 0));
    if (empty) patch(empty.key, fill);
    else setRows((xs) => [...xs, { ...newRow(), ...fill }]);
  };
  // Nama bahan panjang: huruf mengecil sampai muat satu baris (tidak terpotong, tidak dipecah)
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const fit = () => box.current?.querySelectorAll<HTMLElement>(".rcv-row .choice-text").forEach((el) => {
      let size = 14;
      el.style.fontSize = `${size}px`;
      while (el.scrollWidth > el.clientWidth - 2 && size > 10.5) el.style.fontSize = `${(size -= 0.5)}px`;
    });
    const t = window.setTimeout(fit, 60);
    const mo = new MutationObserver(() => window.requestAnimationFrame(fit));
    if (box.current) mo.observe(box.current, { childList: true, subtree: true, characterData: true });
    return () => { window.clearTimeout(t); mo.disconnect(); };
  }, [rows]);
  // Baris kosong (bahan belum dipilih DAN jumlah kosong/0) diabaikan; error hanya untuk baris setengah terisi
  const qtyOf = (r: ReceiptRow) => Number(r.qty.replace(/\./g, "").replace(",", "."));
  const filled = rows.filter((r) => r.itemId || qtyOf(r) > 0);
  const save = () =>
    run(async () => {
      // Baris yang belum lengkap: kolomnya ditandai merah & difokus (isian lain tetap)
      const mark = (label: string, text: string) => {
        const el = box.current?.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label^="${label}"]`);
        if (el) markInvalid(el, text);
        return new Error(text);
      };
      if (!filled.length) throw new Error("Tidak ada barang baru");
      const noItem = rows.findIndex((r) => (r.itemId || qtyOf(r) > 0) && !r.itemId);
      if (noItem >= 0) throw mark(`Barang ${noItem + 1}`, "Pilih barang di baris ini");
      const noQty = rows.findIndex((r) => r.itemId && !(qtyOf(r) > 0));
      if (noQty >= 0) throw mark(`Jumlah barang ${noQty + 1}`, "Isi jumlahnya");
      const fd = new FormData();
      fd.set("id", id);
      fd.set("lines", JSON.stringify(filled.map((r) => ({ itemId: r.itemId, qty: r.qty, purchaseLineId: r.orderLine || null, supplierName: r.orderLine ? r.shop : null }))));
      if (anyCod) fd.set("bankAccountId", bank);
      if (photo) fd.set("photo", new File([photo.blob], "nota.jpg", { type: photo.blob.type || "image/jpeg" }));
      return addReceipts(fd);
    }, `${filled.length} barang masuk tercatat`).then((ok) => {
      if (!ok) return;
      setRows([newRow()]);
      setPhoto(null);
    });
  return (
    <section>
      <p className="mb-3 text-xs text-slate-500">Isi DULU sebelum menghitung stok akhir: barang dari supplier/toko yang datang di shift ini. Barang ini tidak dihitung sebagai pemakaian. Owner/Admin nanti mencatat harga & pembayarannya di Stok → Pembelian.</p>
      {receipts.length > 0 && (
        <ul className="mb-3 divide-y divide-slate-100 text-sm">
          {receipts.map((x) => (
            <li key={x.id} className="flex items-center gap-2 py-1.5">
              {x.hasPhoto ? <ProofPreview thumb src={`/api/files/receipt/${x.id}`} title={`Nota ${x.number}`} thumbClass="h-10 w-10 object-cover" /> : <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-dashed border-slate-300 text-xs text-slate-400">nota</span>}
              <div className="min-w-0 flex-1">
                <div>{x.itemName}: <b>{fmt(x.qty)}</b> {x.unit}</div>
                <div className="text-xs text-slate-500">{x.number}{x.supplierName ? ` · ${x.supplierName}` : ""} · {x.linked ? "✓ tercatat di Pembelian" : "menunggu dicatat di Pembelian"}</div>
              </div>
              {!x.linked && !applied && (
                <button type="button" className="btn-secondary btn-sm shrink-0" disabled={busy} onClick={() => {
                  if (!window.confirm("Hapus barang masuk ini?")) return;
                  const fd = new FormData();
                  fd.set("id", id);
                  fd.set("receiptId", x.id);
                  run(() => removeReceipt(fd), "Barang masuk dihapus");
                }}>Hapus</button>
              )}
            </li>
          ))}
        </ul>
      )}
      {orders.length > 0 && (
        <div className="mb-3">
          <p className="mb-1.5 text-xs font-medium text-slate-600">Rekomendasi: pesanan yang sedang dalam perjalanan</p>
          <ul className="space-y-1.5">
            {orders.map((o) => {
              const on = rows.some((r) => r.orderLine === o.lineId);
              return (
                <li key={o.lineId}>
                  <button type="button" aria-pressed={on} onClick={() => toggleOrder(o)}
                    className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left text-sm transition ${on ? "border-brand-500 bg-brand-50 ring-2 ring-brand-100" : "border-slate-200 hover:bg-slate-50"}`}>
                    <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border text-[11px] ${on ? "border-brand-600 bg-brand-600 text-white" : "border-slate-300"}`}>{on ? "✓" : ""}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium text-slate-800">{o.itemName} · {fmt(o.remaining)} {o.unit}</span>
                      <span className="block text-xs text-slate-500">{o.vendor}{o.cod ? " · COD" : ""}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="mt-1.5 text-xs text-slate-500">Atau pilih barang lain secara manual di bawah.</p>
        </div>
      )}
      <div ref={box} className="space-y-2">
        <div className="flex gap-1.5 text-xs font-semibold text-slate-500" aria-hidden><span className="flex-1">Nama bahan</span><span className={`w-[4.5rem] ${rows.length > 1 ? "mr-[1.875rem]" : ""}`}>Jumlah</span></div>
        {rows.map((r, i) => {
          const unit = materials.find((m) => m.id === r.itemId)?.unit;
          const order = orderOf(r);
          return (
            <div key={r.key} className="rcv-row border-b border-slate-100 pb-2">
              {/* Satu baris: nama bahan | jumlah + satuan | hapus */}
              <div className="flex items-center gap-1.5">
                <div className="min-w-0 flex-1">
                  <select value={r.itemId} onChange={(e) => patch(r.key, { itemId: e.target.value, orderLine: "", shop: "" })} className="input px-2 text-sm" aria-label={`Barang ${i + 1}`}>
                    <option value="">— pilih bahan —</option>
                    {materials.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                </div>
                <span className="relative w-[4.5rem] shrink-0">
                  <input value={r.qty} onChange={(e) => patch(r.key, { qty: e.target.value })} inputMode="decimal" className={`input px-1.5 text-right tabular-nums ${unit ? "pr-8" : ""}`} placeholder="0" aria-label={`Jumlah barang ${i + 1}${unit ? ` (${unit})` : ""}`} />
                  {unit && <span className="pointer-events-none absolute inset-y-0 right-1.5 flex items-center text-[10px] font-medium text-slate-500" aria-hidden>{unit.length > 4 ? unit.slice(0, 4) : unit}</span>}
                </span>
                {rows.length > 1 && <button type="button" className="grid h-9 w-6 shrink-0 place-items-center rounded-md text-rose-600 hover:bg-rose-50" onClick={() => setRows((xs) => xs.filter((x) => x.key !== r.key))} aria-label={`Hapus baris barang ${i + 1}`}>✕</button>}
              </div>
              {order && <p className="mt-1 text-xs text-sky-700">Dari pesanan {order.vendor}{order.cod ? " (COD)" : ""}: stok masuk dan {order.cod ? "pembayaran COD" : "uang muka/hutang"} tercatat otomatis. Tidak perlu dicatat lagi di Pembelian.</p>}
            </div>
          );
        })}
        <button type="button" className="btn-secondary w-full" onClick={() => setRows((xs) => [...xs, newRow()])}>+ Tambah barang</button>
        {anyCod && (
          <label className="block"><span className="text-xs font-medium text-slate-600">Bayar COD dari</span>
            <select value={bank} onChange={(e) => setBank(e.target.value)} className="input">{banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
          </label>
        )}
        <div><span className="text-xs font-medium text-slate-600">Foto nota (opsional, satu untuk semua barang di atas)</span>
          <div className="flex items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {photo && <img src={photo.url} alt="Foto nota" className="h-10 w-10 rounded-md object-cover" />}
            <button type="button" className="btn-secondary btn-sm" onClick={() => setCam(true)}>📷 {photo ? "Ganti foto" : "Foto nota"}</button>
            {photo && <button type="button" className="text-xs text-slate-500 underline" onClick={() => setPhoto(null)}>Hapus</button>}
          </div>
          <CameraCapture open={cam} title="Foto nota" onClose={() => setCam(false)} onCapture={(blob) => setPhoto({ blob, url: URL.createObjectURL(blob) })} />
        </div>
        <button type="button" className="btn-primary w-full py-3 text-base" disabled={busy || !filled.length} onClick={save}>{busy ? "Menyimpan…" : !filled.length ? "Tidak ada barang baru" : filled.length > 1 ? `Simpan semua (${filled.length} barang)` : "Simpan barang masuk"}</button>
      </div>
    </section>
  );
}

function PhotoTask({ id, index, entry }: { id: string; index: number; entry: ChecklistEntry }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [cam, setCam] = useState(false);
  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>, ok: string) => {
    setBusy(true);
    try {
      const r = await fn();
      if (!r.ok) throw new Error(r.error);
      toast(ok);
      router.refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Gagal", false);
    } finally {
      setBusy(false);
    }
  };
  // Foto langsung diunggah begitu diambil (sudah dikompres di HP) → tersimpan di draf laporan di server
  const upload = (blob: Blob) => {
    setUploading(true);
    return run(async () => {
      const fd = new FormData();
      fd.set("id", id);
      fd.set("index", String(index));
      fd.set("photo", new File([blob], "foto.jpg", { type: blob.type || "image/jpeg" }));
      return uploadChecklistPhoto(fd);
    }, "Foto tersimpan").finally(() => setUploading(false));
  };
  const src = entry.photoPath ? `/api/files/report/${id}/${index}?v=${encodeURIComponent(entry.photoPath.split("/").pop() ?? "")}` : null;
  return (
    <div className="flex flex-1 items-center gap-3">
      {src ? (
        <ProofPreview thumb src={src} title={entry.label} thumbClass="h-12 w-12 object-cover" />
      ) : (
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md border border-dashed border-slate-300 text-lg text-slate-400">📷</span>
      )}
      <div className="min-w-0 flex-1">
        <div className="text-sm">{isDone(entry) ? "✓ " : ""}{entry.label}</div>
        <div className="text-xs text-slate-500">{busy ? "Mengunggah foto…" : src ? "Foto bukti terlampir" : "Wajib foto bukti"}</div>
      </div>
      <CameraCapture
        open={cam}
        title={entry.label}
        onClose={() => setCam(false)}
        onCapture={upload}
        onBeforeExternal={() => writeReopen(reportReopenKey(id), { item: index })}
      />
      <div className="flex shrink-0 flex-col gap-1 sm:flex-row">
        <button
          type="button"
          data-flush-draft
          className="btn-secondary btn-sm"
          disabled={busy}
          onClick={() => {
            writeReopen(reportReopenKey(id), { item: index });
            setCam(true);
          }}
        >
          {busy ? "…" : src ? "Ganti" : "Foto"}
        </button>
        {src && (
          <button
            type="button"
            className="btn-secondary btn-sm"
            disabled={busy}
            onClick={() => {
              if (!window.confirm("Hapus foto bukti ini?")) return;
              const fd = new FormData();
              fd.set("id", id);
              fd.set("index", String(index));
              run(() => removeChecklistPhoto(fd), "Foto dihapus");
            }}
          >
            Hapus
          </button>
        )}
      </div>
    </div>
  );
}

/** Satu baris hitung stok: nama (boleh 2 baris) + keterangan kecil di kiri, kolom angka kecil + satuan di kanan */
function CountRow({ name, sub, unit, inputName, inputMode, value, onChange, warn, hidden }: { name: React.ReactNode; sub?: string; unit: string; inputName: string; inputMode: "numeric" | "decimal"; value: string; onChange: (v: string) => void; warn?: boolean; hidden?: boolean }) {
  return (
    <li className={`flex items-center gap-3 py-2 ${hidden ? "hidden" : ""}`}>
      <div className="min-w-0 flex-1">
        <div className={`break-words text-sm leading-snug ${warn ? "font-medium text-amber-700" : "text-slate-800"}`}>{name}</div>
        {sub && <div className="text-xs text-slate-500">{sub}</div>}
      </div>
      <label className="flex shrink-0 items-center gap-1.5">
        <input name={inputName} inputMode={inputMode} value={value} onChange={(e) => onChange(e.target.value)} className="input w-[4.5rem] py-1.5 text-right" placeholder="0" aria-label={typeof name === "string" ? name : undefined} />
        <span className="w-12 break-words text-[11px] leading-tight text-slate-500">{unit}</span>
      </label>
    </li>
  );
}
