import type { Prisma, PrismaClient } from "@prisma/client";
import { StockError, locationOfType, locationSettings, recordMovement } from "./stock";

/**
 * Rekonsiliasi LOKASI stok (pratinjau dulu): tiap barang punya SATU lokasi menurut jenisnya (locationOfType: bahan → gudang bahan,
 * setengah jadi → gudang setengah jadi, barang jadi → gudang barang jadi). Saldo di gudang LAIN (raw/wip/finished) dipindahkan ke lokasi itu dengan TRANSFER
 * (nilai tidak berubah, tanpa jurnal, ref REKON:LOKASI:<sku>). Saldo NEGATIF di gudang lain ditutup dari lokasi yang benar (net total tetap).
 * Lokasi titik borongan / driver / stok divisi (Assembling, Giftbox) sengaja tidak disentuh (stok dalam proses atau hasil "Ambil stok").
 */
type Db = PrismaClient | Prisma.TransactionClient;
const EPS = 0.0005;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

export type LokasiSaldo = { id: string; lokasi: string; qty: number; gudang: boolean };
export type LokasiUsulan = { fromId: string; toId: string; from: string; to: string; qty: number };
export type LokasiRow = { itemId: string; sku: string; name: string; type: string; avgCost: number; canonical: string | null; saldo: LokasiSaldo[]; total: number; usulan: LokasiUsulan[]; negatif: boolean };

export async function planLokasiStok(db: Db): Promise<LokasiRow[]> {
  const locs = await locationSettings(db);
  const wh = new Set([locs.raw, locs.wip, locs.finished].filter((x): x is string => !!x));
  const names = new Map((await db.location.findMany({ select: { id: true, name: true } })).map((l) => [l.id, l.name]));
  const mvs = await db.stockMovement.findMany({ select: { itemId: true, qty: true, fromLocationId: true, toLocationId: true } });
  const bal = new Map<string, Map<string, number>>();
  const add = (i: string, l: string, q: number) => { const m = bal.get(i) ?? new Map<string, number>(); m.set(l, (m.get(l) ?? 0) + q); bal.set(i, m); };
  for (const m of mvs) { const q = Number(m.qty); if (m.toLocationId) add(m.itemId, m.toLocationId, q); if (m.fromLocationId) add(m.itemId, m.fromLocationId, -q); }
  const items = await db.item.findMany({ where: { id: { in: [...bal.keys()] } }, select: { id: true, sku: true, name: true, type: true, avgCost: true } });
  const rows: LokasiRow[] = [];
  for (const it of items) {
    const per = bal.get(it.id)!;
    const canon = locationOfType(it.type, locs);
    const saldo = [...per].map(([id, qty]) => ({ id, lokasi: names.get(id) ?? id, qty: r3(qty), gudang: wh.has(id) })).filter((x) => Math.abs(x.qty) > EPS);
    const usulan: LokasiUsulan[] = [];
    if (canon) for (const s of saldo.filter((x) => x.gudang && x.id !== canon)) {
      usulan.push(s.qty > 0 ? { fromId: s.id, toId: canon, from: s.lokasi, to: names.get(canon) ?? canon, qty: s.qty } : { fromId: canon, toId: s.id, from: names.get(canon) ?? canon, to: s.lokasi, qty: -s.qty });
    }
    const total = r3(saldo.reduce((a, x) => a + x.qty, 0));
    const negatif = saldo.some((x) => x.qty < 0);
    if (usulan.length || negatif) rows.push({ itemId: it.id, sku: it.sku, name: it.name, type: it.type, avgCost: Number(it.avgCost), canonical: canon ? names.get(canon) ?? canon : null, saldo, total, usulan, negatif });
  }
  return rows.sort((a, b) => a.type.localeCompare(b.type) || a.sku.localeCompare(b.sku));
}

export async function koreksiLokasiStok(db: PrismaClient, apply: boolean, opt: { onlySku?: (sku: string) => boolean } = {}) {
  const rows = (await planLokasiStok(db)).filter((r) => !opt.onlySku || opt.onlySku(r.sku));
  if (!apply) return { rows, transfers: 0 };
  let transfers = 0;
  const actor = { id: "system", name: "skrip koreksi:lokasi-stok" };
  for (const r of rows) {
    if (!r.usulan.length) continue;
    await db.$transaction(async (tx) => {
      for (const u of r.usulan) {
        if (!(u.qty > EPS)) throw new StockError("Jumlah transfer tidak valid");
        await recordMovement(tx, { type: "TRANSFER", itemId: r.itemId, qty: u.qty, fromLocationId: u.fromId, toLocationId: u.toId, allowNegative: true, ref: `REKON:LOKASI:${r.sku}`, note: `Rekonsiliasi lokasi: ${u.from} → ${u.to}`, date: new Date() }, actor);
        transfers++;
      }
    }, { timeout: 30000 });
  }
  return { rows, transfers };
}
