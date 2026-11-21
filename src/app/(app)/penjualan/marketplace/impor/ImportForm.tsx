"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { detectSlotsAction, finishImportJobAction, previewOneFileAction, saveOneFileAction, startImportJobAction } from "../actions";
import { toast } from "@/components/Toaster";

const KIND = { ORDER: "Pesanan", INCOME: "Penghasilan", BALANCE: "Buku Saldo Penjual", ADSBILL: "Saldo iklan" } as const;
const CH = { SHP: "Shopee", TTS: "TikTok" } as const;
const nf = (v: number) => v.toLocaleString("id-ID");
const MAX_BYTES = 12 * 1024 * 1024;
/** Semua panggilan server dibungkus: kegagalan (koneksi, ukuran, server) selalu jadi pesan per file, tidak pernah halaman galat */
const SAFE = "Tidak bisa menghubungi server (koneksi terputus atau file terlalu besar). Coba lagi atau unggah file ini sendiri.";
async function safe<T>(fn: () => Promise<T>): Promise<T | { ok: false; error: string }> {
  try { return await fn(); } catch { return { ok: false, error: SAFE }; }
}

export type SlotInfo = { key: string; label: string; example: string; steps: string[]; note: string };
export type Card = { storeId: string; storeName: string; channel: "SHP" | "TTS"; slots: (SlotInfo & { lastAt: string | null; lastFile: string | null; periodFrom: string | null; periodTo: string | null })[] };
type Preview = Awaited<ReturnType<typeof previewOneFileAction>> extends { file?: infer F } ? NonNullable<F> : never;

const fmtD = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Jakarta" }) : "-");
const ageDays = (iso: string | null) => (iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86400000) : null);

/** Satu file di daftar: status dicek sendiri-sendiri; hanya yang "ok" ikut disimpan */
type Item = {
  uid: number; file: File; slot: string | null; reason?: string; channel?: "SHP" | "TTS"; kind?: string; hash?: string; from?: string | null; to?: string | null;
  status: "cek" | "ok" | "salah" | "dobel" | "toko"; msg?: string;
};
let seq = 0;

/** Kartu per toko × kanal, slot per jenis file (boleh banyak file per slot). Unggah, pratinjau & simpan SATU FILE per panggilan: jumlah & total ukuran tidak dibatasi. */
export function ImportForm({ cards, canManage }: { cards: Card[]; canManage: boolean }) {
  const [items, setItems] = useState<Item[]>([]);
  const [work, setWork] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Preview[] | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [pickStore, setPickStore] = useState(cards[0]?.storeId ?? "");
  const router = useRouter();
  type Prog = { id: number; name: string; state: "tunggu" | "jalan" | "ok" | "gagal" | "lewat"; text: string };
  const [prog, setProg] = useState<Prog[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [after, setAfter] = useState<{ failed?: number; total?: number; month?: string; ok: boolean } | null>(null);
  const working = busy || !!work;

  // Tahan refresh/tutup tab selama proses berjalan
  useEffect(() => {
    if (!working) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = "Proses impor masih berjalan. Jika halaman ditutup, file yang belum tersimpan akan terlewat."; };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [working]);

  const slotLabel = (id: string) => { const [st, ch, k] = id.split("|"); const c = cards.find((x) => x.storeId === st && x.channel === ch); return `${c?.storeName ?? ""} · ${ch === "SHP" ? "Shopee" : "TikTok"} · ${c?.slots.find((x) => x.key === k)?.label ?? k}`; };
  const upd = (uid: number, patch: Partial<Item>) => setItems((c) => c.map((x) => (x.uid === uid ? { ...x, ...patch } : x)));
  const reset = () => { setPreviews(null); setSaved(null); if (!busy) { setProg(null); setAfter(null); } };
  const valid = items.filter((x) => x.status === "ok" && x.slot);
  /** Urutan simpan: pesanan dulu, lalu periode lama → baru (periode dari isi file) */
  const ordered = useMemo(() => [...valid].sort((a, b) => (a.kind === "ORDER" ? 0 : 1) - (b.kind === "ORDER" ? 0 : 1) || (a.from ?? "").localeCompare(b.from ?? "") || a.file.name.localeCompare(b.file.name)), [valid]);

  /** Kenali & cek tiap file satu per satu; target = slot tempat file dijatuhkan (null = urut otomatis) */
  const addFiles = async (list: FileList | File[], target: string | null) => {
    const files = [...list];
    if (!files.length) return;
    reset();
    const fresh: Item[] = files.map((file) => ({ uid: ++seq, file, slot: target, status: "cek" as const }));
    setItems((c) => [...c, ...fresh]);
    const seen = new Set(items.map((x) => x.hash).filter(Boolean) as string[]);
    for (let i = 0; i < fresh.length; i++) {
      const it = fresh[i];
      setWork(`Membaca file ${i + 1}/${fresh.length}: ${it.file.name}`);
      if (!/\.(xlsx|csv)$/i.test(it.file.name)) { upd(it.uid, { status: "salah", msg: "Bukan file .xlsx / .csv dari Seller Center." }); continue; }
      if (it.file.size > MAX_BYTES) { upd(it.uid, { status: "salah", msg: `File ${(it.file.size / 1048576).toFixed(1)} MB terlalu besar (maks 12 MB). Unduh per bulan dari Seller Center.` }); continue; }
      const f = new FormData();
      f.append("file", it.file);
      if (target) f.append("target", target);
      const r = await safe(() => detectSlotsAction(f));
      const d = "items" in r ? r.items?.[0] : undefined;
      if (!r.ok || !d) { upd(it.uid, { status: "salah", msg: ("error" in r && r.error) || "Gagal membaca file" }); continue; }
      const base = { channel: d.channel, kind: d.kind, hash: d.hash, from: d.periodFrom, to: d.periodTo, reason: d.reason };
      if (d.error) { upd(it.uid, { ...base, status: "salah", msg: d.error }); continue; }
      if (d.duplicate) { upd(it.uid, { ...base, status: "dobel", msg: d.duplicate }); continue; }
      if (d.hash && seen.has(d.hash)) { upd(it.uid, { ...base, status: "dobel", msg: "Isi sama persis dengan file lain di daftar (mis. unduhan ganda). Dilewati." }); continue; }
      if (d.hash) seen.add(d.hash);
      if (d.needStore || !d.storeId) { upd(it.uid, { ...base, status: "toko", msg: "Toko belum bisa ditentukan dari isi file. Pilih toko di bawah." }); continue; }
      upd(it.uid, { ...base, slot: target ?? `${d.storeId}|${d.channel}|${d.kind}`, status: "ok" });
    }
    setWork(null);
  };

  /** File tanpa nama toko: pilih toko sekali untuk semuanya; dicek ulang di server (username / pesanan di toko lain) */
  const assignStore = async () => {
    const pend = items.filter((x) => x.status === "toko");
    for (let i = 0; i < pend.length; i++) {
      const it = pend[i];
      if (!it.channel || !it.kind) continue;
      const slot = `${pickStore}|${it.channel}|${it.kind}`;
      setWork(`Memeriksa ${i + 1}/${pend.length}: ${it.file.name}`);
      const f = new FormData();
      f.append("file", it.file); f.append("target", slot);
      const r = await safe(() => detectSlotsAction(f));
      const d = "items" in r ? r.items?.[0] : undefined;
      if (!r.ok || !d) upd(it.uid, { status: "salah", msg: ("error" in r && r.error) || "Gagal membaca file" });
      else if (d.error) upd(it.uid, { status: "salah", msg: d.error });
      else upd(it.uid, { slot, status: "ok", msg: undefined });
    }
    setWork(null);
  };

  const preview = async () => {
    reset();
    const out: Preview[] = [];
    for (let i = 0; i < ordered.length; i++) {
      const it = ordered[i];
      setWork(`Mencocokkan ${i + 1}/${ordered.length}: ${it.file.name}`);
      const [storeId, ch] = it.slot!.split("|");
      const f = new FormData();
      f.append("file", it.file); f.append("storeId", storeId);
      if (ordered.some((o) => o.kind === "ORDER" && o.slot!.startsWith(`${storeId}|${ch}|`))) f.append("ordersInBatch", "1");
      const r = await safe(() => previewOneFileAction(f));
      if ("file" in r && r.file) out.push(r.file);
      else out.push({ fileName: it.file.name, storeName: "", platform: "", kind: it.kind ?? "", channel: ch, periodFrom: null, periodTo: null, total: 0, baru: 0, diperbarui: 0, dilewati: 0, withdrawals: 0, adsRows: 0, unmapped: [], incomeNoOrder: 0, changes: {}, error: ("error" in r && r.error) || "Gagal membaca file" } as Preview);
    }
    setWork(null);
    setPreviews(out);
  };

  /** Simpan file satu per satu (pesanan dulu, lama → baru). Satu file gagal tidak menghentikan yang lain. */
  const save = async () => {
    const list = ordered;
    const rows: Prog[] = list.map((it) => ({ id: it.uid, name: `${it.file.name} — ${slotLabel(it.slot!)}`, state: "tunggu", text: "menunggu" }));
    setProg(rows); setAfter(null); setBusy(true); setSaved(null);
    const set = (i: number, state: Prog["state"], text: string) => { rows[i] = { ...rows[i], state, text }; setProg([...rows]); };
    const job = await safe(() => startImportJobAction(list.length, slotLabel(list[0].slot!)));
    if (!job.ok || !("id" in job) || !job.id) { setProg(null); setBusy(false); toast(("error" in job && job.error) || "Gagal memulai impor", false); return; }
    let ok = 0, baru = 0, upd2 = 0, skip = 0, fail = 0;
    const done: number[] = [];
    for (let i = 0; i < list.length; i++) {
      set(i, "jalan", "mengunggah, membaca, mencocokkan & menyimpan…");
      const f = new FormData();
      f.append("file", list[i].file); f.append("storeId", list[i].slot!.split("|")[0]); f.append("jobId", job.id); f.append("done", String(i + 1));
      const r = await safe(() => saveOneFileAction(f));
      if (r.ok) {
        ok++; done.push(list[i].uid);
        if ("skipped" in r && r.skipped) set(i, "ok", r.skipped);
        else { baru += (r as { baru?: number }).baru ?? 0; upd2 += (r as { diperbarui?: number }).diperbarui ?? 0; skip += (r as { dilewati?: number }).dilewati ?? 0; set(i, "ok", `${(r as { baru?: number }).baru} baru · ${(r as { diperbarui?: number }).diperbarui} diperbarui · ${(r as { dilewati?: number }).dilewati} dilewati`); }
      } else { fail++; set(i, "gagal", ("error" in r && r.error) || "gagal"); }
    }
    const msg = fail ? `Impor selesai sebagian: ${ok} file berhasil, ${fail} gagal` : `Impor tersimpan: ${ok} file · ${baru} baru, ${upd2} diperbarui, ${skip} dilewati (sama persis)`;
    setWork("Menghitung ulang saldo, integritas & buku bayangan…");
    const fin = await safe(() => finishImportJobAction(job.id!, fail === 0, msg));
    setWork(null);
    setAfter({ ok: fail === 0, failed: "failed" in fin ? fin.failed : undefined, total: "total" in fin ? fin.total : undefined, month: "month" in fin ? fin.month : undefined });
    setBusy(false);
    toast(msg, fail === 0);
    setSaved(fail ? null : msg);
    setItems((c) => c.filter((x) => !done.includes(x.uid) && x.status !== "dobel"));
    setPreviews(null);
    router.refresh();
  };

  if (!canManage) return <p className="text-sm text-slate-500">Hanya pengguna dengan izin kelola penjualan yang bisa mengimpor.</p>;
  const p = previews ? { files: previews, totals: { baru: previews.reduce((a, f) => a + f.baru, 0), diperbarui: previews.reduce((a, f) => a + f.diperbarui, 0), dilewati: previews.reduce((a, f) => a + f.dilewati, 0), perluDicek: previews.reduce((a, f) => a + f.unmapped.length + (f.incomeNoOrder ? 1 : 0) + (f.error ? 1 : 0), 0) } } : null;
  const done = prog ? prog.filter((x) => x.state === "ok" || x.state === "gagal" || x.state === "lewat").length : 0;
  const reasonOf = new Map(items.filter((x) => x.reason).map((x) => [x.file.name, x.reason]));
  const needStore = items.filter((x) => x.status === "toko");
  const problems = items.filter((x) => x.status === "salah" || x.status === "dobel");
  const picker = (slot: string | null, label: string) => (
    <label className="btn-secondary btn-sm cursor-pointer">{label}<input type="file" accept=".xlsx,.csv" multiple hidden disabled={working} onChange={(e) => { const l = e.target.files ? [...e.target.files] : []; e.target.value = ""; void addFiles(l, slot); }} /></label>
  );

  return (
    <div className="space-y-4">
      <div
        className="rounded-xl border-2 border-dashed border-slate-300 bg-white p-4 text-center text-sm text-slate-500"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); if (!working) void addFiles(e.dataTransfer.files, null); }}
      >
        <p>Punya banyak file? Tarik semuanya ke sini (berapa pun jumlahnya) — masuk otomatis ke slot yang benar, urut dari periode lama ke baru.</p>
        <div className="mt-2">{picker(null, "Pilih banyak file")}</div>
        <p className="mt-1 text-xs text-slate-400">Tiap file dikirim satu per satu, jadi tidak ada batas jumlah/total ukuran; hanya maksimal 12 MB per file. File yang tidak memuat nama toko (pesanan, TikTok) cukup ditetapkan tokonya sekali.</p>
      </div>
      {work && <div className="rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-800"><p>{work}</p><div className="mt-2 h-2 overflow-hidden rounded bg-sky-100"><div className="h-2 w-1/3 animate-pulse rounded bg-sky-500" /></div></div>}

      {needStore.length > 0 && (
        <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
          <p className="font-medium text-amber-900">{needStore.length} file belum diketahui tokonya (pesanan/TikTok tidak memuat nama toko):</p>
          <ul className="list-disc pl-5 text-xs text-amber-900">{needStore.map((x) => <li key={x.uid} className="break-all">{x.file.name} <span className="text-amber-700">{x.reason ? `${x.reason} · ` : ""}({x.channel ? CH[x.channel] : ""} · {x.kind ? KIND[x.kind as keyof typeof KIND] : ""}{x.from ? ` · ${x.from} s/d ${x.to}` : ""})</span></li>)}</ul>
          <div className="flex flex-wrap items-center gap-2">
            <select className="input w-auto" value={pickStore} onChange={(e) => setPickStore(e.target.value)} aria-label="Toko">{[...new Map(cards.map((c) => [c.storeId, c.storeName])).entries()].map(([id, n]) => <option key={id} value={id}>{n}</option>)}</select>
            <button type="button" className="btn-primary btn-sm" disabled={working} onClick={() => void assignStore()}>Tetapkan toko untuk semua</button>
            <button type="button" className="btn-secondary btn-sm" disabled={working} onClick={() => setItems((c) => c.filter((x) => x.status !== "toko"))}>Hapus file ini</button>
          </div>
          <p className="text-xs text-amber-800">Dicek ulang di server: pesanan yang sudah tercatat di toko lain atau username yang tidak cocok akan ditolak.</p>
        </div>
      )}
      {problems.length > 0 && (
        <ul className="space-y-1 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs">
          {problems.map((x) => <li key={x.uid} className={x.status === "salah" ? "text-rose-700" : "text-slate-600"}>{x.status === "salah" ? "⛔" : "↷"} <b className="break-all">{x.file.name}</b>: {x.msg} <button type="button" className="ml-1 underline" onClick={() => setItems((c) => c.filter((y) => y.uid !== x.uid))}>hapus</button></li>)}
        </ul>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        {cards.map((c) => (
          <div key={`${c.storeId}|${c.channel}`} className="card space-y-2 p-3">
            <p className="font-semibold">{c.storeName} · {c.channel === "SHP" ? "Shopee" : "TikTok Shop"}</p>
            {c.slots.map((sl) => {
              const id = `${c.storeId}|${c.channel}|${sl.key}`;
              const mine = items.filter((x) => x.slot === id && x.status === "ok").sort((a, b) => (a.from ?? "").localeCompare(b.from ?? ""));
              const age = ageDays(sl.lastAt);
              return (
                <div
                  key={id}
                  className={`rounded-lg border p-2 text-sm ${mine.length ? "border-emerald-300 bg-emerald-50" : "border-slate-200 bg-white"}`}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => { e.preventDefault(); e.stopPropagation(); if (!working) void addFiles(e.dataTransfer.files, id); }}
                >
                  <div className="flex flex-wrap items-center gap-2"><b className="flex-1">{sl.label}</b>{picker(id, mine.length ? "Tambah file" : "Pilih file")}</div>
                  <p className="break-all text-xs text-slate-400">Contoh: {sl.example}</p>
                  {mine.map((x) => (
                    <p key={x.uid} className="flex items-start justify-between gap-2 break-all text-xs text-emerald-700"><span>✓ {x.file.name}{x.from ? ` · ${x.from} s/d ${x.to}` : ""}{x.reason ? <span className="block text-emerald-900/70">toko otomatis: {x.reason}</span> : null}</span><button type="button" className="shrink-0 underline" disabled={working} onClick={() => { setItems((cur) => cur.filter((y) => y.uid !== x.uid)); reset(); }}>hapus</button></p>
                  ))}
                  <p className={`text-xs ${age === null ? "text-slate-400" : age > 3 ? "text-amber-700" : "text-slate-500"}`}>
                    {sl.lastAt ? `Terakhir diunggah ${fmtD(sl.lastAt)}${age ? ` (${age} hari lalu)` : " (hari ini)"}${sl.periodTo ? ` · periode ${fmtD(sl.periodFrom)} – ${fmtD(sl.periodTo)}` : ""}` : "Belum pernah diunggah"}
                  </p>
                  <details className="text-xs text-slate-500">
                    <summary className="cursor-pointer text-sky-700">Cara unduh</summary>
                    <ol className="mt-1 list-decimal space-y-0.5 pl-4">{sl.steps.map((t, i) => <li key={i}>{t}</li>)}</ol>
                    <p className="mt-1 text-slate-600">{sl.note}</p>
                    <p className="mt-1 text-slate-400">Letak menu di Seller Center bisa sedikit berbeda; yang penting nama file mirip contoh.</p>
                  </details>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {ordered.length > 0 && !p && !prog && (
        <div className="flex items-center gap-2"><button type="button" className="btn-primary" disabled={working} onClick={() => void preview()}>{work ? "Membaca…" : `Pratinjau ${ordered.length} file`}</button></div>
      )}

      {prog && (
        <div className="card space-y-2 p-3 text-sm">
          <div className="flex items-center justify-between"><b>{busy ? "Impor sedang berjalan — jangan tutup atau muat ulang halaman" : after?.ok ? "Impor selesai ✓" : "Impor selesai sebagian ✗"}</b><span className="tabular-nums text-xs text-slate-500">{done}/{prog.length} file · {Math.round((done / prog.length) * 100)}%</span></div>
          <div className="h-2 overflow-hidden rounded bg-slate-100"><div className={`h-2 rounded transition-all ${after && !after.ok ? "bg-amber-500" : "bg-emerald-500"}`} style={{ width: `${Math.max(busy ? 5 : 0, (done / prog.length) * 100)}%` }} /></div>
          <ul className="space-y-1">{prog.map((x) => <li key={x.id} className={`rounded px-2 py-1 text-xs ${x.state === "ok" ? "bg-emerald-50 text-emerald-800" : x.state === "gagal" ? "bg-rose-50 text-rose-800" : x.state === "jalan" ? "bg-sky-50 text-sky-800" : "bg-slate-50 text-slate-500"}`}>{x.state === "ok" ? "✓" : x.state === "gagal" ? "✗" : x.state === "jalan" ? "⏳" : "•"} <b className="break-all">{x.name}</b> — {x.text}</li>)}</ul>
          {after && <p className="text-xs text-slate-600">{after.total ? `Cek integritas ${after.month}: ${after.failed ? `${after.failed} dari ${after.total} pemeriksaan perlu dilihat` : "semua lolos"}. ` : ""}<Link className="link" href="/penjualan/marketplace/rekon">Buka Cek Integritas →</Link>{!after.ok && " File yang gagal tetap ada di daftar slot; perbaiki lalu simpan ulang."}</p>}
        </div>
      )}
      {saved && <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{saved}</div>}

      {p && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[["Pesanan/baris baru", p.totals.baru], ["Diperbarui status", p.totals.diperbarui], ["Dilewati (sama persis)", p.totals.dilewati], ["Perlu dicek", p.totals.perluDicek]].map(([l, v]) => (
              <div key={l as string} className="card p-3"><p className="text-xs text-slate-500">{l}</p><p className="text-xl font-semibold tabular-nums">{nf(v as number)}</p></div>
            ))}
          </div>
          {p.files.map((f, i) => (
            <div key={i} className="card space-y-2 p-3 text-sm">
              {reasonOf.get(f.fileName) && <p className="text-xs text-sky-800">Toko ditentukan otomatis dari isi file: {reasonOf.get(f.fileName)}</p>}
              <div className="flex flex-wrap items-center gap-2">
                <b className="break-all">{f.fileName}</b>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs">{CH[f.channel as "SHP" | "TTS"]} · {KIND[f.kind as keyof typeof KIND] ?? f.kind}</span>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs">{f.storeName}</span>
                {f.periodFrom && <span className="text-xs text-slate-500">{f.periodFrom} s/d {f.periodTo}</span>}
              </div>
              {f.error && <p className="rounded bg-rose-50 px-2 py-1 text-xs font-medium text-rose-700">⛔ {f.error}</p>}
              {f.note && <p className="rounded bg-slate-50 px-2 py-1 text-xs text-slate-600">{f.note}</p>}
              {f.seller && <p className="text-xs text-slate-500">Penjual di file: {f.seller}</p>}
              {f.sheets && <p className="text-xs text-slate-600">Sheet dibaca: {f.sheets.read.join(", ")}{f.sheets.skipped.length > 0 && <> · dilewati: {f.sheets.skipped.map((x) => `${x.name} (${x.reason})`).join("; ")}</>}</p>}
              {f.personalCols && f.personalCols.length > 0 && <p className="text-xs text-slate-500">Kolom sengaja tidak disimpan (data pribadi): {f.personalCols.join(", ")}</p>}
              {f.extras && <p className="rounded bg-sky-50 px-2 py-1 text-xs text-sky-800">Sheet tambahan: Selisih ongkir {nf(f.extras.shipDisc)} pesanan ({nf(f.extras.shipDiscBaru)} baru) · Seller Fee {nf(f.extras.sellerFee)} pesanan ({nf(f.extras.sellerFeeBaru)} baru)</p>}
              <p>{nf(f.total)} {f.kind === "ORDER" ? "pesanan" : "baris"}: <b>{nf(f.baru)}</b> baru, <b>{nf(f.diperbarui)}</b> diperbarui, {nf(f.dilewati)} dilewati{f.adsRows ? ` · ${f.adsRows} potongan iklan/penyesuaian` : ""}{f.withdrawals ? ` · ${f.withdrawals} penarikan` : ""}</p>
              {Object.keys(f.changes).length > 0 && <p className="rounded bg-sky-50 px-2 py-1 text-xs text-sky-800">Perubahan pada pesanan yang sudah ada: {Object.entries(f.changes).map(([k, v]) => `${k}: ${nf(v)}`).join(" · ")}</p>}
              {f.incomeNoOrder > 0 && <p className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">{nf(f.incomeNoOrder)} penghasilan belum punya pesanan di ERP — tetap disimpan, cocok otomatis saat file pesanannya diunggah (atau dengan file pesanan yang ikut dalam unggahan ini).</p>}
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
            <button type="button" className="btn-primary" disabled={working || p.files.some((x) => x.error)} onClick={save}>{busy ? "Menyimpan…" : "Simpan impor"}</button>
            <button type="button" className="btn-secondary" disabled={working} onClick={() => setPreviews(null)}>Batal</button>
          </div>
          {p.files.some((x) => x.error) && <p className="text-xs text-amber-700">Ada file bermasalah (⛔). Hapus file itu dulu agar bisa disimpan.</p>}
        </div>
      )}
    </div>
  );
}
