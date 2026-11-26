import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { n } from "../money";
import { categoryOf, UNMAPPED, isCounted, type FeeCategory } from "./feeMap";
import { feeOverrides } from "./potongan";
import { platformOf } from "./rules";
import { marketplaceBanks, recordedWithdraws } from "./bank";

/**
 * BUKU BAYANGAN marketplace (Opsi B, mode SIMULASI). Jurnal penuh diturunkan dari data impor + withdraw, disimpan di tabel
 * TERPISAH (MarketplaceGl*), tidak menyentuh jurnal/Neraca/Laba Rugi nyata. Aman dibangun ulang kapan saja (idempoten).
 * Satu jurnal per hari per jenis per toko × kanal (ringkas; rincian pesanan tetap di data impor).
 */
export const GL_MODE_KEY = "marketplace_gl_mode"; // SIMULASI (bawaan) | LIVE (belum tersedia di PR ini)
export const GL_OPEN_KEY = "marketplace_gl_open_date"; // tanggal saldo pembuka; jurnal dibangun untuk tanggal SETELAH ini
export const GL_DEFAULT_OPEN = "2026-11-20"; // simulasi mulai 21 Nov; saat aktivasi diganti 2026-11-30 (jurnal nyata mulai 1 Des)

export type Wallet = "PENJUAL" | "IKLAN";
export const GL_ACCOUNTS: Record<string, { name: string; type: "ASET" | "EKUITAS" | "PENDAPATAN" | "BEBAN" }> = {
  "1-1211": { name: "Saldo Penjual Shopee MG", type: "ASET" },
  "1-1212": { name: "Saldo Penjual Shopee DL", type: "ASET" },
  "1-1213": { name: "Saldo Penjual TikTok MG", type: "ASET" },
  "1-1214": { name: "Saldo Penjual TikTok DL", type: "ASET" },
  "1-1221": { name: "Saldo Iklan Shopee MG", type: "ASET" },
  "1-1222": { name: "Saldo Iklan Shopee DL", type: "ASET" },
  "3-9000": { name: "Ekuitas Saldo Awal", type: "EKUITAS" },
  "4-1100": { name: "Penjualan Marketplace", type: "PENDAPATAN" },
  "4-1190": { name: "Retur & Refund Marketplace (kontra)", type: "PENDAPATAN" },
  "6-1510": { name: "Beban Admin / Komisi Marketplace", type: "BEBAN" },
  "6-1520": { name: "Beban Proses Pesanan", type: "BEBAN" },
  "6-1530": { name: "Beban Program Ongkir (Xtra / logistik)", type: "BEBAN" },
  "6-1540": { name: "Beban Selisih Ongkir", type: "BEBAN" },
  "6-1550": { name: "Beban Komisi Affiliate", type: "BEBAN" },
  "6-1560": { name: "Beban Ongkir Sampel Affiliate", type: "BEBAN" },
  "6-1570": { name: "Beban Voucher Penjual", type: "BEBAN" },
  "6-1580": { name: "Beban Asuransi Pengiriman", type: "BEBAN" },
  "6-1590": { name: "Beban Layanan Live / Video", type: "BEBAN" },
  "6-1600": { name: "Beban Pajak (PPh) Marketplace", type: "BEBAN" },
  "6-1610": { name: "Beban Iklan Shopee", type: "BEBAN" },
  "6-1611": { name: "Beban Iklan TikTok (GMV Pay)", type: "BEBAN" },
  "6-1620": { name: "Beban PPN Iklan", type: "BEBAN" },
  "6-1630": { name: "Beban Penyesuaian Marketplace Lainnya", type: "BEBAN" },
  "6-1640": { name: "Selisih Marketplace Belum Terjelaskan", type: "BEBAN" },
  "6-1850": { name: "Kerugian Pesanan Hilang (kompensasi)", type: "BEBAN" },
};
/** Akun bank/kas tujuan withdraw yang tak ditemukan di COA nyata */
export const GL_UNKNOWN_BANK = "1-1100";

export const saldoPenjual = (storeCode: string, channel: string) => ({ "SHP|MG": "1-1211", "SHP|DL": "1-1212", "TTS|MG": "1-1213", "TTS|DL": "1-1214" } as Record<string, string>)[`${channel}|${storeCode}`] ?? null;
export const saldoIklan = (storeCode: string) => ({ MG: "1-1221", DL: "1-1222" } as Record<string, string>)[storeCode] ?? null;

/** Kategori biaya → akun beban */
const EXPENSE: Partial<Record<FeeCategory, string>> = {
  ADMIN: "6-1510", PROSES: "6-1520", ONGKIR_PROGRAM: "6-1530", ONGKIR: "6-1540", AFFILIATE: "6-1550", AFFILIATE_SAMPEL: "6-1560", VOUCHER: "6-1570",
  ASURANSI: "6-1580", LAYANAN: "6-1590", PAJAK: "6-1600", PENYESUAIAN: "6-1630", LAINNYA: "6-1630", REFUND: "4-1190", PESANAN_HILANG: "6-1850",
};
const expenseOf = (cat: FeeCategory | typeof UNMAPPED, channel: string) => (cat === "IKLAN" ? (channel === "SHP" ? "6-1610" : "6-1611") : cat === UNMAPPED ? "6-1630" : (EXPENSE[cat] ?? "6-1630"));

const wib = (d: Date) => new Date(d.getTime() + 7 * 3600000).toISOString().slice(0, 10);
const atDay = (day: string) => new Date(`${day}T05:00:00Z`); // 12.00 WIB (aman dari batas hari)

export type GlLine = { account: string; debit: number; credit: number; memo?: string };
export type GlJournal = { key: string; date: Date; at?: Date; storeId: string; channel: string; kind: "SETTLE" | "ADS" | "ADJ" | "WD" | "OPEN"; description: string; lines: GlLine[] };

/** Saldo bersih per akun (debit positif) → baris jurnal; selisih ditaruh di 6-1640 agar selalu seimbang */
export function linesFromNet(net: Map<string, number>, memos?: Map<string, string>): GlLine[] {
  let sum = 0;
  for (const v of net.values()) sum += v;
  const m = new Map(net);
  if (sum !== 0) m.set("6-1640", (m.get("6-1640") ?? 0) - sum);
  return [...m.entries()].filter(([, v]) => v !== 0).map(([account, v]) => ({ account, debit: v > 0 ? v : 0, credit: v < 0 ? -v : 0, memo: memos?.get(account) })).sort((a, b) => a.account.localeCompare(b.account));
}
const add = (m: Map<string, number>, account: string, debitMinusCredit: number) => m.set(account, (m.get(account) ?? 0) + Math.round(debitMinusCredit));

type Ev = { releasedAt: Date; released: number; productAmt: number; feeDetail: Record<string, number>; kind: string };

/** Jurnal cair pesanan satu hari (SETTLE): Dr Saldo Penjual · Cr Penjualan · Dr beban per kategori · Dr kontra refund */
export function settleLines(events: Ev[], saldoCode: string, channel: string, overrides: Map<string, string>): GlLine[] {
  const net = new Map<string, number>();
  const platform = platformOf(channel);
  for (const e of events) {
    add(net, saldoCode, e.released);
    add(net, "4-1100", -e.productAmt);
    for (const [col, v] of Object.entries(e.feeDetail)) {
      const c = categoryOf(platform, col, overrides);
      if (c === UNMAPPED || !isCounted(c, platform)) continue; // belum dipetakan / info → masuk selisih (6-1640), tampil di Cek Integritas
      add(net, expenseOf(c, channel), -v); // v negatif = potongan → debit beban
    }
  }
  return linesFromNet(net);
}

/** Jurnal iklan satu hari (ADS): isi saldo iklan (+PPN sebagai beban), pemakaian/rebate, GMV Pay TikTok */
export function adsLines(events: Ev[], saldoCode: string, iklanCode: string | null, channel: string): GlLine[] {
  const net = new Map<string, number>();
  let topup = 0, fund = 0;
  for (const e of events) {
    if (e.kind === "TOPUP") topup += Math.abs(e.released);
    else if (e.kind === "ADSUSE") {
      const desc = Object.keys(e.feeDetail)[0] ?? "";
      if (/isi saldo|top.?up/i.test(desc)) fund += e.released;
      else if (iklanCode) { add(net, iklanCode, e.released); add(net, "6-1610", -e.released); } // pemakaian (negatif): Dr beban, Cr saldo iklan
    } else if (e.kind === "ADS") { add(net, saldoCode, e.released); add(net, channel === "SHP" ? "6-1610" : "6-1611", -e.released); } // GMV Pay
  }
  // Isi saldo: saldo iklan naik sebesar yang masuk menurut file iklan (fund); uang keluar dari saldo penjual (topup). Selisih = PPN iklan (beban).
  const out = topup || fund, inn = fund || topup;
  if (out && iklanCode) {
    add(net, saldoCode, -out);
    add(net, iklanCode, inn);
    if (out > inn) add(net, "6-1620", out - inn);
  }
  return linesFromNet(net);
}

/** Penyesuaian (ADJ): sampel affiliate, kompensasi pesanan hilang, penyesuaian lain */
export function adjLines(events: Ev[], saldoCode: string, channel: string, overrides: Map<string, string>): GlLine[] {
  const net = new Map<string, number>();
  const platform = platformOf(channel);
  for (const e of events) {
    add(net, saldoCode, e.released);
    const entries = Object.entries(e.feeDetail);
    const total = entries.reduce((a, [, v]) => a + v, 0);
    if (!entries.length || total !== e.released) { add(net, "6-1630", -e.released); continue; }
    for (const [desc, v] of entries) {
      const c = categoryOf(platform, desc, overrides);
      const acct = /kompensasi|pesanan hilang|barang hilang/i.test(desc) ? "6-1850" : c === UNMAPPED ? "6-1630" : expenseOf(c as FeeCategory, channel);
      add(net, acct, -v);
    }
  }
  return linesFromNet(net);
}

export async function glOpenDate() {
  return (await prisma.setting.findUnique({ where: { key: GL_OPEN_KEY } }))?.value ?? GL_DEFAULT_OPEN;
}

/** Turunkan SEMUA jurnal bayangan dari data (tanggal > tanggal saldo pembuka). Murni baca; penyimpanan ada di rebuildGl(). */
export async function deriveJournals(): Promise<GlJournal[]> {
  const openDate = await glOpenDate();
  const after = new Date(`${openDate}T17:00:00Z`); // > akhir hari saldo pembuka (WIB)
  const stores = await prisma.store.findMany({ where: { active: true, code: { in: ["MG", "DL"] } }, select: { id: true, code: true, name: true } });
  const overrides = await feeOverrides();
  const banks = await marketplaceBanks();
  const out: GlJournal[] = [];
  for (const s of stores) {
    for (const ch of ["SHP", "TTS"]) {
      const sp = saldoPenjual(s.code, ch);
      if (!sp) continue;
      const evs = await prisma.marketplaceIncomeEvent.findMany({ where: { income: { storeId: s.id, channel: ch }, releasedAt: { gt: after } }, select: { released: true, productAmt: true, feeDetail: true, releasedAt: true, income: { select: { kind: true } } } });
      const by = new Map<string, Map<string, Ev[]>>(); // jenis → hari → event
      for (const e of evs) {
        const k = e.income.kind;
        const kind = k === "ORDER" ? "SETTLE" : k === "ADJUST" ? "ADJ" : "ADS";
        const day = wib(e.releasedAt!);
        const m = by.get(kind) ?? new Map<string, Ev[]>();
        m.set(day, [...(m.get(day) ?? []), { releasedAt: e.releasedAt!, released: n(e.released), productAmt: n(e.productAmt), feeDetail: (e.feeDetail ?? {}) as Record<string, number>, kind: k }]);
        by.set(kind, m);
      }
      const label = `${s.name} · ${ch === "SHP" ? "Shopee" : "TikTok"}`;
      for (const [kind, days] of by) {
        for (const [day, list] of days) {
          const lines = kind === "SETTLE" ? settleLines(list, sp, ch, overrides) : kind === "ADJ" ? adjLines(list, sp, ch, overrides) : adsLines(list, sp, saldoIklan(s.code), ch);
          if (!lines.length) continue;
          out.push({ key: `${kind}|${s.id}|${ch}|${day}`, date: atDay(day), at: ch === "TTS" ? new Date(`${day}T08:00:00+07:00`) : new Date(Math.max(...list.map((e) => e.releasedAt.getTime()))), storeId: s.id, channel: ch, kind: kind as GlJournal["kind"], description: `${kind === "SETTLE" ? "Pencairan pesanan" : kind === "ADJ" ? "Penyesuaian saldo" : "Iklan"} ${label} ${day}`, lines });
        }
      }
      // withdraw yang sudah dicatat di Keuangan
      const wd = await recordedWithdraws(s, ch, banks, stores.length, after, new Date("2100-01-01"));
      if (wd.rows.length) {
        const txs = await prisma.financeTransaction.findMany({ where: { id: { in: wd.rows.map((r) => r.id) } }, select: { id: true, toAccountId: true } });
        const to = new Map(txs.map((t) => [t.id, t.toAccountId]));
        const bankCoa = new Map((await prisma.bankAccount.findMany({ select: { id: true, coaAccount: { select: { code: true } } } })).map((b) => [b.id, b.coaAccount.code]));
        for (const r of wd.rows) {
          const bank = (to.get(r.id) && bankCoa.get(to.get(r.id)!)) || GL_UNKNOWN_BANK;
          out.push({ key: `WD|${r.id}`, date: atDay(wib(r.date)), at: r.date, storeId: s.id, channel: ch, kind: "WD", description: `Withdraw ${label}${r.withdrawRef ? ` (${r.withdrawRef})` : ""}`, lines: [{ account: bank, debit: r.amount, credit: 0 }, { account: sp, debit: 0, credit: r.amount }] });
        }
      }
    }
  }
  // saldo pembuka (dari tabel input)
  const opens = await prisma.marketplaceGlOpening.findMany();
  for (const o of opens) {
    const s = stores.find((x) => x.id === o.storeId);
    if (!s || !n(o.amount)) continue;
    const acct = o.wallet === "IKLAN" ? saldoIklan(s.code) : saldoPenjual(s.code, o.channel);
    if (!acct) continue;
    const v = n(o.amount);
    out.push({ key: `OPEN|${o.storeId}|${o.channel}|${o.wallet}`, date: atDay(openDate), storeId: o.storeId, channel: o.channel, kind: "OPEN", description: `Saldo pembuka ${o.wallet === "IKLAN" ? "saldo iklan" : "saldo penjual"} ${s.name} · ${o.channel === "SHP" ? "Shopee" : "TikTok"}`, lines: [{ account: acct, debit: v > 0 ? v : 0, credit: v < 0 ? -v : 0 }, { account: "3-9000", debit: v < 0 ? -v : 0, credit: v > 0 ? v : 0 }] });
  }
  return out.sort((a, b) => a.date.getTime() - b.date.getTime() || a.key.localeCompare(b.key));
}

/**
 * Hitung mundur saldo pembuka: pengguna mengisi saldo pada tanggal+jam tertentu (mis. dari Seller Center hari ini);
 * pembuka = saldo itu − mutasi buku bayangan (dari jurnal turunan, tanpa pembuka) yang terjadi setelah tanggal pembuka sampai instan itu.
 * Mutasi harian dianggap terjadi pada jam peristiwa terakhirnya (TikTok: 08.00 WIB).
 */
export async function openingFromBalance(storeId: string, channel: string, wallet: Wallet, balance: number, asOfAt: Date): Promise<{ opening: number; movement: number; count: number }> {
  const store = await prisma.store.findUniqueOrThrow({ where: { id: storeId }, select: { code: true } });
  const acct = wallet === "IKLAN" ? saldoIklan(store.code) : saldoPenjual(store.code, channel);
  if (!acct) throw new Error("Akun saldo tidak dikenal");
  const openDate = await glOpenDate();
  const after = new Date(`${openDate}T17:00:00Z`);
  let movement = 0, count = 0;
  for (const j of await deriveJournals()) {
    if (j.kind === "OPEN" || j.storeId !== storeId || j.channel !== channel) continue;
    const at = j.at ?? j.date;
    if (at <= after || at > asOfAt) continue;
    const net = j.lines.filter((l) => l.account === acct).reduce((a, l) => a + l.debit - l.credit, 0);
    if (net) { movement += net; count++; }
  }
  return { opening: balance - movement, movement, count };
}

/** Bangun ulang buku bayangan: hapus semua jurnal bayangan lalu tulis ulang (tidak menyentuh jurnal nyata) */
export async function rebuildGl() {
  const journals = await deriveJournals();
  await prisma.$transaction(async (tx) => {
    // Dua pembangunan ulang bersamaan (impor selesai + tombol Bangun ulang) bentrok di kunci unik: serialkan, yang kedua menimpa yang pertama
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('marketplace-gl-rebuild'))`;
    await tx.marketplaceGlJournal.deleteMany({});
    for (let i = 0; i < journals.length; i += 200) {
      for (const j of journals.slice(i, i + 200)) {
        await tx.marketplaceGlJournal.create({ data: { key: j.key, date: j.date, storeId: j.storeId, channel: j.channel, kind: j.kind, description: j.description, lines: { create: j.lines.map((l) => ({ account: l.account, debit: BigInt(l.debit), credit: BigInt(l.credit), memo: l.memo ?? null })) } } as Prisma.MarketplaceGlJournalCreateInput });
      }
    }
  }, { timeout: 300_000, maxWait: 30_000 });
  return { journals: journals.length, openDate: await glOpenDate() };
}

/** Neraca saldo bayangan: per akun, total debit/kredit/saldo (rentang tanggal & filter toko opsional) */
export async function glTrialBalance(f: { storeId?: string; channel?: string; to?: Date } = {}) {
  const lines = await prisma.marketplaceGlLine.findMany({ where: { journal: { ...(f.storeId ? { storeId: f.storeId } : {}), ...(f.channel ? { channel: f.channel } : {}), ...(f.to ? { date: { lte: f.to } } : {}) } }, select: { account: true, debit: true, credit: true } });
  const m = new Map<string, { debit: number; credit: number }>();
  for (const l of lines) {
    const e = m.get(l.account) ?? { debit: 0, credit: 0 };
    e.debit += n(l.debit); e.credit += n(l.credit);
    m.set(l.account, e);
  }
  const rows = [...m.entries()].map(([code, v]) => ({ code, name: GL_ACCOUNTS[code]?.name ?? code, type: GL_ACCOUNTS[code]?.type ?? "ASET", ...v, balance: v.debit - v.credit })).sort((a, b) => a.code.localeCompare(b.code));
  const sum = (t: string) => rows.filter((r) => r.type === t).reduce((a, r) => a + r.balance, 0);
  return { rows, totalDebit: rows.reduce((a, r) => a + r.debit, 0), totalCredit: rows.reduce((a, r) => a + r.credit, 0), pendapatan: -sum("PENDAPATAN"), beban: sum("BEBAN"), laba: -sum("PENDAPATAN") - sum("BEBAN") };
}

/** Saran saldo pembuka dari file: Shopee penjual = Saldo Akhir (balanceAfter) terakhir sampai tanggal itu; saldo iklan = Σ mutasi iklan */
export async function suggestOpening(storeId: string, channel: string, wallet: Wallet, asOf: string): Promise<{ amount: number; note: string } | null> {
  const end = new Date(`${asOf}T17:00:00Z`);
  if (channel === "SHP" && wallet === "PENJUAL") {
    const last = await prisma.marketplaceBalanceTx.findFirst({ where: { storeId, channel, date: { lte: end }, balanceAfter: { not: null } }, orderBy: [{ date: "desc" }, { pos: "asc" }] });
    return last ? { amount: n(last.balanceAfter), note: `Saldo Akhir di file Saldo Penjual (${wib(last.date)})` } : null;
  }
  if (channel === "SHP" && wallet === "IKLAN") {
    const agg = await prisma.marketplaceIncomeEvent.aggregate({ where: { income: { storeId, channel, kind: "ADSUSE" }, releasedAt: { lte: end } }, _sum: { released: true }, _count: true });
    return agg._count ? { amount: n(agg._sum.released), note: `Σ mutasi file Saldo Iklan sampai ${asOf} (isi saldo − pemakaian)` } : null;
  }
  return null; // TikTok: file tidak punya saldo berjalan → diisi manual dari Seller Center
}

