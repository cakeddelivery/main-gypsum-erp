"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ActionForm, Submit } from "@/components/ActionForm";
import { useCloseGuard, useCloseModal } from "@/components/Modal";
import { revealField } from "@/components/FormFeedback";
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
  type CatalogLine,
  type ReportCatalogs,
  type ChecklistEntry,
  type GridRow,
  type GridSection,
  type ReportTemplate,
  type StockCountRow,
  type WorkData,
} from "@/lib/shiftReport";
import { addReceipt, removeChecklistPhoto, removeReceipt, saveReport, uploadChecklistPhoto } from "../actions";

/** Baris pesanan yang sedang dikirim (Stok → Pembelian) untuk barang divisi ini */
export type OrderOption = { lineId: string; itemId: string; label: string; remaining: number; cod: boolean; vendor: string; itemName: string; unit: string };
export type ReceiptView = { id: string; number: string; itemName: string; unit: string; qty: number; supplierName: string | null; hasPhoto: boolean; linked: boolean };
export type ResultCountRow = { key: string; label: string; unit: string; qty: number | null; group?: string };

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
  /** Hasil kerja yang masuk stok saat dikirim (kosong bila fitur mati) */
  flow: string[] | null;
  /** Laporan sudah pernah dikirim (kirim ulang = revisi) */
  sent: boolean;
};

type Step = { key: string; label: string };

const fmt = (v: number) => v.toLocaleString("id-ID");
const toNum = (s: string) => (s.trim() === "" ? null : Math.max(0, Math.round(Number(s.replace(/\./g, "").replace(/,/g, ".")) || 0)));

/** Perkecil foto di HP sebelum diunggah (maks. 1600 px, JPEG) agar cepat & hemat kuota */
async function shrink(file: File): Promise<Blob> {
  if (!file.type.startsWith("image/")) throw new Error("File harus berupa foto");
  const img = await createImageBitmap(file).catch(() => null);
  if (!img) return file;
  const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise((res) => canvas.toBlob((b) => res(b ?? file), "image/jpeg", 0.8));
}

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
    { key: "catatan", label: "Catatan & kirim" },
  ];
  const [step, setStep] = useState(0);
  const [seen, setSeen] = useState(() => new Set([0]));
  const cur = steps[Math.min(step, steps.length - 1)].key;
  const last = step >= steps.length - 1;
  const close = useCloseModal();
  const formRef = useRef<HTMLDivElement>(null);
  const bodyTop = useRef<HTMLElement>(null);
  const go = (i: number) => {
    setStep(i);
    setSeen((x) => new Set(x).add(i));
  };
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
  const matches = (label: string) => !rcQuery.trim() || label.toLowerCase().includes(rcQuery.trim().toLowerCase());
  const rcGroups = Object.entries(
    p.resultCount.reduce<Record<string, ResultCountRow[]>>((m, r) => ((m[r.group ?? "Lainnya"] ??= []).push(r), m), {}),
  );
  // Tutup (✕ di bawah atau di judul popup): konfirmasi simpan draf / buang perubahan bila ada isian berubah
  const [dirty, setDirty] = useState(false);
  const [closeAsk, setCloseAsk] = useState(false);
  const askClose = () => (dirty ? setCloseAsk(true) : close());
  const setGuard = useCloseGuard();
  useEffect(() => {
    setGuard(askClose);
    return () => setGuard(null);
  });
  // Kolom wajib yang kosong di langkah lain: buka langkahnya lalu gulir & fokus ke kolom itu
  useEffect(() => {
    const el = formRef.current;
    if (!el) return;
    const onInvalid = (e: Event) => {
      const box = (e.target as HTMLElement).closest<HTMLElement>("[data-step]");
      const i = steps.findIndex((x) => x.key === box?.dataset.step);
      if (i < 0 || steps[i].key === cur) return;
      go(i);
      const target = e.target as HTMLElement;
      window.setTimeout(() => revealField(target), 60);
    };
    el.addEventListener("invalid", onInvalid, true);
    return () => el.removeEventListener("invalid", onInvalid, true);
  });
  const show = (key: string) => (key === cur ? "" : "hidden");

  return (
    <div ref={formRef} onInput={() => setDirty(true)} onChange={() => setDirty(true)}>
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
        window.setTimeout(close, 750);
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
            <li key={i} className={`flex items-center gap-3 rounded-lg border px-3 py-2 ${(c.photo ? c.photoPath : checks[i]) ? "border-emerald-200 bg-emerald-50" : "border-slate-200"}`}>
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
        <button type="button" className="btn-secondary btn-icon" aria-label="Tutup laporan" onClick={askClose}>✕</button>
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
            <p className="mt-1 text-sm text-slate-600">Ada isian yang belum disimpan. Simpan sebagai draf agar bisa dilanjutkan nanti.</p>
            <div className="mt-4 grid gap-2">
              <span className="flex" onClickCapture={() => (sending.current = false)}>
                <Submit className="btn-primary flex-1" name="intent" value="draft" pendingText="Menyimpan…">Simpan draf</Submit>
              </span>
              <button type="button" className="btn-danger" onClick={() => { setCloseAsk(false); close(); }}>Buang perubahan</button>
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



export function ReceiptSection({ id, receipts, materials, applied, orders, banks }: { id: string; receipts: ReceiptView[]; materials: { id: string; name: string; unit: string }[]; applied: boolean; orders: OrderOption[]; banks: { id: string; name: string }[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [itemId, setItemId] = useState("");
  const [qty, setQty] = useState("");
  const [shop, setShop] = useState("");
  const photo = useRef<HTMLInputElement>(null);
  const unit = materials.find((m) => m.id === itemId)?.unit;
  const itemOrders = orders.filter((o) => o.itemId === itemId);
  const [orderLine, setOrderLine] = useState("");
  const [bank, setBank] = useState(banks[0]?.id ?? "");
  const order = itemOrders.find((o) => o.lineId === orderLine);
  // Pilih barang manual: bukan dari pesanan → kolom supplier tidak ditampilkan & dikosongkan
  const pick = (id: string) => {
    setItemId(id);
    setOrderLine("");
    setShop("");
  };
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
  const add = () =>
    run(async () => {
      if (!itemId) throw new Error("Pilih barang dulu");
      const fd = new FormData();
      fd.set("id", id);
      fd.set("itemId", itemId);
      fd.set("qty", qty);
      fd.set("supplierName", shop);
      if (order) {
        fd.set("purchaseLineId", order.lineId);
        if (order.cod) fd.set("bankAccountId", bank);
      }
      const f = photo.current?.files?.[0];
      if (f) {
        const blob = await shrink(f);
        fd.set("photo", new File([blob], "nota.jpg", { type: blob.type || "image/jpeg" }));
      }
      return addReceipt(fd);
    }, "Barang masuk tercatat").then((ok) => {
      if (!ok) return;
      setItemId("");
      setQty("");
      setOrderLine("");
      if (photo.current) photo.current.value = "";
    });
  return (
    <section className="card p-4">
      <h3 className="mb-1 font-semibold text-slate-800">Barang masuk hari ini</h3>
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
              const on = orderLine === o.lineId;
              return (
                <li key={o.lineId}>
                  <button
                    type="button"
                    aria-pressed={on}
                    onClick={() => {
                      if (on) return pick("");
                      setItemId(o.itemId);
                      setOrderLine(o.lineId);
                      setShop(o.vendor);
                      setQty(String(o.remaining).replace(".", ","));
                    }}
                    className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left text-sm transition ${on ? "border-brand-500 bg-brand-50 ring-2 ring-brand-100" : "border-slate-200 hover:bg-slate-50"}`}
                  >
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
      <div className="grid grid-cols-12 gap-2 rounded-lg border border-slate-200 p-2 [&>*]:min-w-0">
        <label className="col-span-12 sm:col-span-6"><span className="text-xs text-slate-500">Barang</span>
          <select value={itemId} onChange={(e) => pick(e.target.value)} className="input py-1.5">
            <option value="">— pilih bahan —</option>
            {materials.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </label>
        <label className={order ? "col-span-5 sm:col-span-3" : "col-span-12 sm:col-span-6"}><span className="text-xs text-slate-500">Jumlah</span>
          <span className="relative block">
            <input value={qty} onChange={(e) => setQty(e.target.value)} inputMode="decimal" className={`input py-1.5 ${unit ? "pr-14" : ""}`} placeholder="0" />
            {unit && <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-slate-800 opacity-25" aria-hidden>{unit}</span>}
          </span>
        </label>
        {order && (
          <label className="col-span-7 sm:col-span-3"><span className="text-xs text-slate-500">Supplier</span><input value={shop} readOnly tabIndex={-1} className="input bg-slate-100 py-1.5 dark:bg-slate-800" /></label>
        )}
        {order?.cod && (
          <label className="col-span-12 sm:col-span-5"><span className="text-xs text-slate-500">Bayar COD dari</span>
            <select value={bank} onChange={(e) => setBank(e.target.value)} className="input py-1.5">{banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
          </label>
        )}
        {order && <p className="col-span-12 text-xs text-sky-700">Barang ini divalidasi sebagai penerimaan pesanan: stok masuk dan {order.cod ? "pembayaran COD" : "uang muka/hutang"} tercatat otomatis. Tidak perlu dicatat lagi di Pembelian.</p>}
        <label className="col-span-12 sm:col-span-8"><span className="text-xs text-slate-500">Foto nota (opsional)</span><input ref={photo} type="file" accept="image/*" capture="environment" className="block w-full text-sm" /></label>
        <div className="col-span-12 flex items-end sm:col-span-4"><button type="button" className="btn-primary btn-sm w-full" disabled={busy} onClick={add}>{busy ? "Menyimpan…" : "+ Catat barang masuk"}</button></div>
      </div>
    </section>
  );
}

function PhotoTask({ id, index, entry }: { id: string; index: number; entry: ChecklistEntry }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
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
        <div className="text-xs text-slate-500">{src ? "Foto bukti terlampir" : "Wajib foto bukti"}</div>
      </div>
      <input
        ref={input}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          run(async () => {
            const blob = await shrink(f);
            const fd = new FormData();
            fd.set("id", id);
            fd.set("index", String(index));
            fd.set("photo", new File([blob], "foto.jpg", { type: blob.type || "image/jpeg" }));
            return uploadChecklistPhoto(fd);
          }, "Foto tersimpan");
        }}
      />
      <div className="flex shrink-0 flex-col gap-1 sm:flex-row">
        <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => input.current?.click()}>{busy ? "…" : src ? "Ganti" : "Foto"}</button>
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
        <div className={`line-clamp-2 text-sm leading-snug ${warn ? "font-medium text-amber-700" : "text-slate-800"}`}>{name}</div>
        {sub && <div className="text-xs text-slate-500">{sub}</div>}
      </div>
      <label className="flex shrink-0 items-center gap-1.5">
        <input name={inputName} inputMode={inputMode} value={value} onChange={(e) => onChange(e.target.value)} className="input w-20 py-1.5 text-right" placeholder="0" aria-label={typeof name === "string" ? name : undefined} />
        <span className="w-14 truncate text-xs text-slate-500" title={unit}>{unit}</span>
      </label>
    </li>
  );
}
