"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ActionForm, Submit } from "@/components/ActionForm";
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
export type OrderOption = { lineId: string; itemId: string; label: string; remaining: number; cod: boolean };
export type ReceiptView = { id: string; number: string; itemName: string; unit: string; qty: number; supplierName: string | null; hasPhoto: boolean; linked: boolean };
export type ResultCountRow = { key: string; label: string; unit: string; qty: number | null };

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
};

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

  return (
    <ActionForm action={saveReport} className="space-y-4">
      <input type="hidden" name="id" value={p.id} />
      <section className="card p-4">
        <label className="block">
          <span className="label">PIC divisi (yang melaporkan)</span>
          <input name="picName" defaultValue={p.picName} className="input" required />
        </label>
      </section>

      {t && t.sections.some((s) => !(s.kind === "grid" && s.legacy) || gridRows(p.work, s as GridSection).length > 0) && (
        <section className="card space-y-4 p-4">
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

      <section className="card p-4">
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

      {p.materials.length > 0 && <ReceiptSection id={p.id} receipts={p.receipts} materials={p.materials} applied={p.applied} orders={p.orders} banks={p.banks} />}

      {p.resultTitle && p.resultCount.length > 0 && (
        <section className="card p-4">
          <h3 className="mb-1 font-semibold text-slate-800">{p.resultTitle}</h3>
          <p className="mb-3 text-xs text-slate-500">Hitung fisik sisa di gudang setelah hasil kerja dihitung. Kosongkan bila tidak dihitung.</p>
          <div className="keep-cols grid grid-cols-2 gap-2 sm:grid-cols-4">
            {p.resultCount.map((r) => (
              <label key={r.key} className="block">
                <span className="text-xs text-slate-500">{r.label} ({r.unit})</span>
                <input name={`rc.${r.key}`} inputMode="numeric" defaultValue={r.qty ?? ""} placeholder="—" className="input py-1.5" />
              </label>
            ))}
          </div>
        </section>
      )}

      {stock.length > 0 && (
        <section className="card p-4">
          <h3 className="mb-1 font-semibold text-slate-800">Stok akhir shift</h3>
          <p className="mb-3 text-xs text-slate-500">Hitung fisik sisa bahan baku divisi. Bahan dengan stok ≤ limit otomatis masuk daftar order.</p>
          <ul className="divide-y divide-slate-100">
            {stock.map((row, i) => {
              const low = needsOrder(row);
              return (
                <li key={row.itemId} className="flex items-center gap-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className={`text-sm ${low ? "font-medium text-amber-700" : ""}`}>{low && "⚠ "}{row.name}</div>
                    <div className="text-xs text-slate-500">limit {fmt(row.limit)} {row.unit}</div>
                  </div>
                  <div className="flex w-36 shrink-0 items-center gap-1.5">
                    <input
                      name={`s.${row.itemId}`}
                      inputMode="decimal"
                      value={row.qty ?? ""}
                      onChange={(e) => { const s = e.target.value.trim(); const q = s === "" ? null : Math.max(0, Number(s.replace(",", ".")) || 0); setStock((x) => x.map((r, j) => (j === i ? { ...r, qty: q } : r))); }}
                      className="input py-1.5 text-right"
                      placeholder="0"
                    />
                    <span className="w-12 truncate text-xs text-slate-500">{row.unit}</span>
                  </div>
                </li>
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

      <section className="card space-y-3 p-4">
        <label className="block"><span className="label">Catatan / kendala</span><textarea name="complaints" defaultValue={p.complaints} className="input" rows={3} /></label>
        <label className="block"><span className="label">Tindak lanjut</span><textarea name="followUp" defaultValue={p.followUp} className="input" rows={2} /></label>
        <label className="block"><span className="label">Status tindak lanjut</span>
          <select name="followUpStatus" defaultValue={p.followUpStatus} className="input"><option value="BELUM">Belum</option><option value="PROSES">Proses</option><option value="SELESAI">Selesai</option></select>
        </label>
      </section>
      <div className="sticky bottom-20 z-10 lg:bottom-4">
        <Submit className="btn-primary w-full shadow-lg">Simpan laporan</Submit>
      </div>
    </ActionForm>
  );
}

function ReceiptSection({ id, receipts, materials, applied, orders, banks }: { id: string; receipts: ReceiptView[]; materials: { id: string; name: string; unit: string }[]; applied: boolean; orders: OrderOption[]; banks: { id: string; name: string }[] }) {
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
      <div className="grid grid-cols-12 gap-2 rounded-lg border border-slate-200 p-2 [&>*]:min-w-0">
        <label className="col-span-12 sm:col-span-5"><span className="text-xs text-slate-500">Barang</span>
          <select value={itemId} onChange={(e) => { setItemId(e.target.value); const o = orders.find((x) => x.itemId === e.target.value); setOrderLine(o?.lineId ?? ""); if (o) setQty(String(o.remaining).replace(".", ",")); }} className="input py-1.5">
            <option value="">— pilih bahan —</option>
            {materials.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.unit})</option>)}
          </select>
        </label>
        <label className="col-span-5 sm:col-span-2"><span className="text-xs text-slate-500">Jumlah{unit ? ` (${unit})` : ""}</span><input value={qty} onChange={(e) => setQty(e.target.value)} inputMode="decimal" className="input py-1.5" placeholder="0" /></label>
        <label className="col-span-7 sm:col-span-5"><span className="text-xs text-slate-500">Toko / supplier (opsional)</span><input value={shop} onChange={(e) => setShop(e.target.value)} className="input py-1.5" /></label>
        {itemOrders.length > 0 && (
          <label className="col-span-12 sm:col-span-7"><span className="text-xs text-slate-500">Dari pesanan yang dikirim?</span>
            <select value={orderLine} onChange={(e) => setOrderLine(e.target.value)} className="input py-1.5">
              <option value="">Bukan pesanan (beli langsung di toko)</option>
              {itemOrders.map((o) => <option key={o.lineId} value={o.lineId}>{o.label}</option>)}
            </select>
          </label>
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
