"use client";
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { previewMarketplaceAction, saveMarketplaceAction, type PreviewResult } from "../actions";
import { toast } from "@/components/Toaster";

type Store = { id: string; name: string };
const KIND = { ORDER: "Pesanan", INCOME: "Penghasilan" } as const;
const CH = { SHP: "Shopee", TTS: "TikTok" } as const;
const nf = (v: number) => v.toLocaleString("id-ID");

/** Unggah 1–4 file → Pratinjau → Simpan. Pratinjau tidak menulis apa pun; Simpan membaca ulang file di server. */
export function ImportForm({ stores, canManage }: { stores: Store[]; canManage: boolean }) {
  const [files, setFiles] = useState<{ file: File; storeId: string }[]>([]);
  const [res, setRes] = useState<PreviewResult | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const inp = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const fd = () => {
    const f = new FormData();
    for (const x of files) {
      f.append("file", x.file);
      f.append("storeId", x.storeId);
    }
    return f;
  };
  const pick = (list: FileList | null) => {
    if (!list) return;
    const add = [...list].filter((f) => /\.xlsx$/i.test(f.name)).map((file) => ({ file, storeId: stores[0]?.id ?? "" }));
    setFiles((cur) => [...cur, ...add].slice(0, 4));
    setRes(null);
    setSaved(null);
  };
  const preview = () =>
    start(async () => {
      setSaved(null);
      setRes(await previewMarketplaceAction(fd()));
    });
  const save = () =>
    start(async () => {
      const r = await saveMarketplaceAction(fd());
      if (r.ok) {
        toast(r.message ?? "Tersimpan");
        setSaved(r.message ?? "Tersimpan");
        setFiles([]);
        setRes(null);
        router.refresh();
      } else setRes(r);
    });

  if (!canManage) return <p className="text-sm text-slate-500">Hanya pengguna dengan izin kelola penjualan yang bisa mengimpor.</p>;
  const p = res?.preview;
  return (
    <div className="space-y-4">
      <div
        className="rounded-xl border-2 border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          pick(e.dataTransfer.files);
        }}
      >
        <p>Tarik file .xlsx ke sini, atau</p>
        <button type="button" className="btn-secondary mt-2" onClick={() => inp.current?.click()}>Pilih file Excel</button>
        <input ref={inp} type="file" accept=".xlsx" multiple hidden onChange={(e) => { pick(e.target.files); e.target.value = ""; }} />
        <p className="mt-2 text-xs text-slate-400">1–4 file sekaligus. File pesanan dan penghasilan Shopee/TikTok boleh dicampur; jenisnya dikenali otomatis.</p>
      </div>

      {files.length > 0 && (
        <div className="space-y-2">
          {files.map((x, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm">
              <span className="min-w-0 flex-1 break-all">{x.file.name}</span>
              <select className="input w-auto" value={x.storeId} onChange={(e) => setFiles((c) => c.map((y, j) => (j === i ? { ...y, storeId: e.target.value } : y)))} aria-label="Toko">
                {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <button type="button" className="btn-secondary" onClick={() => { setFiles((c) => c.filter((_, j) => j !== i)); setRes(null); }}>Hapus</button>
            </div>
          ))}
          <div className="flex gap-2">
            <button type="button" className="btn-primary" disabled={pending} onClick={preview}>{pending && !p ? "Membaca…" : "Pratinjau"}</button>
          </div>
        </div>
      )}

      {saved && <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{saved}</div>}
      {res && !res.ok && <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{res.error}</div>}
      {res?.fileErrors?.map((e) => <div key={e.fileName} className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"><b>{e.fileName}</b>: {e.error}</div>)}

      {p && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[["Pesanan/baris baru", p.totals.baru], ["Diperbarui status", p.totals.diperbarui], ["Dilewati (sama persis)", p.totals.dilewati], ["Perlu dicek", p.totals.perluDicek]].map(([l, v]) => (
              <div key={l as string} className="card p-3"><p className="text-xs text-slate-500">{l}</p><p className="text-xl font-semibold tabular-nums">{nf(v as number)}</p></div>
            ))}
          </div>
          {p.files.map((f, i) => (
            <div key={i} className="card space-y-2 p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <b className="break-all">{f.fileName}</b>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs">{CH[f.channel as "SHP" | "TTS"]} · {KIND[f.kind as "ORDER" | "INCOME"]}</span>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs">{f.storeName}</span>
                {f.periodFrom && <span className="text-xs text-slate-500">{f.periodFrom} s/d {f.periodTo}</span>}
              </div>
              {f.error && <p className="rounded bg-rose-50 px-2 py-1 text-xs font-medium text-rose-700">⛔ {f.error}</p>}
              {f.note && <p className="rounded bg-slate-50 px-2 py-1 text-xs text-slate-600">{f.note}</p>}
              {f.seller && <p className="text-xs text-slate-500">Penjual di file: {f.seller}</p>}
              <p>{nf(f.total)} {f.kind === "ORDER" ? "pesanan" : "baris"}: <b>{nf(f.baru)}</b> baru, <b>{nf(f.diperbarui)}</b> diperbarui, {nf(f.dilewati)} dilewati{f.adsRows ? ` · ${f.adsRows} potongan iklan/penyesuaian` : ""}{f.withdrawals ? ` · ${f.withdrawals} penarikan` : ""}</p>
              {Object.keys(f.changes).length > 0 && <p className="rounded bg-sky-50 px-2 py-1 text-xs text-sky-800">Perubahan pada pesanan yang sudah ada: {Object.entries(f.changes).map(([k, v]) => `${k}: ${nf(v)}`).join(" · ")}</p>}
              {f.incomeNoOrder > 0 && <p className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">{nf(f.incomeNoOrder)} penghasilan belum punya pesanan di ERP — tetap disimpan, cocok otomatis saat file pesanannya diunggah.</p>}
              {f.unmapped.length > 0 && (
                <div className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">
                  <p className="font-medium">{f.unmapped.length} SKU belum dipetakan ke produk (tetap bisa disimpan; petakan di menu Pemetaan SKU):</p>
                  <ul className="mt-1 list-disc pl-4">{f.unmapped.slice(0, 8).map((u) => <li key={u.key}>{u.sku} {u.name ? `· ${u.name}` : ""} ({u.orders} pesanan)</li>)}{f.unmapped.length > 8 && <li>… dan {f.unmapped.length - 8} lainnya</li>}</ul>
                </div>
              )}
            </div>
          ))}
          <p className="text-xs text-slate-500">Menyimpan hanya mencatat penjualan marketplace. Stok dan jurnal keuangan tidak berubah. Setiap file menjadi satu batch yang bisa dibatalkan.</p>
          <div className="flex gap-2">
            <button type="button" className="btn-primary" disabled={pending || !!res?.fileErrors?.length || !!p.files.some((x) => x.error)} onClick={save}>{pending ? "Menyimpan…" : "Simpan impor"}</button>
            <button type="button" className="btn-secondary" disabled={pending} onClick={() => setRes(null)}>Batal</button>
          </div>
          {!!res?.fileErrors?.length && <p className="text-xs text-amber-700">Hapus file yang bermasalah dulu agar semua file bisa disimpan bersama.</p>}
        </div>
      )}
    </div>
  );
}
