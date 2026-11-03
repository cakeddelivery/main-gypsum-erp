/*
 * Pisahkan akun COA rekening yang dipakai bersama (sekali jalan, aman diulang).
 *
 *   npm run pisahkan:rekening               -> hanya MENAMPILKAN rencana (aman, tidak menyimpan apa pun)
 *   npm run pisahkan:rekening -- --jalankan -> menyimpan perubahan
 *
 * Masalahnya: saldo rekening = saldo akun COA-nya. Bila dua rekening memakai akun COA yang sama
 * (mis. Seabank 0006 & Seabank 5984 sama-sama 1-1201, atau Saldo Penjual TikTok ikut 1-1100 Kas Tunai),
 * saldo keduanya tercampur dan "Total saldo rekening" terhitung DOBEL.
 *
 * Yang dilakukan untuk setiap rekening yang menumpang akun COA rekening lain:
 *   1. Buat akun COA kas/bank baru (1-1204, 1-1205, ...) dengan nama rekening tsb.
 *   2. Rekening dipindah ke akun COA baru; nama akun COA lama disesuaikan dengan rekening yang tetap memakainya.
 *   3. Baris jurnal lama milik rekening tsb dipindah ke akun COA baru, bila asalnya bisa dipastikan:
 *      transaksi menu Transaksi (+ pembaliknya), dana sisihan, pembelian, upah borongan, penyesuaian saldo rekening.
 *      Baris lain yang tidak bisa dipastikan hanya DITAMPILKAN (tetap di rekening lama).
 *   4. Kode rekening yang tidak sesuai nama (mis. HUTANG untuk "Seabank - 0006") diganti kode otomatis dari nama,
 *      dan 4 angka belakang rekening ditambahkan ke alias agar pesan "dari seabank 0006" dikenali.
 *
 * WAJIB backup dulu: npm run backup
 */
import { PrismaClient, type Prisma } from "@prisma/client";
import { autoCode } from "../src/lib/codes";

const prisma = new PrismaClient();
const apply = process.argv.includes("--jalankan");
class DryRun extends Error {}
type Tx = Prisma.TransactionClient;

/** Rekening bawaan & akun COA aslinya: rekening ini yang tetap memakai akun lama */
const SEED_OWNER: Record<string, string> = { "1-1100": "KAS", "1-1201": "SEABANK", "1-1202": "SHOPEEPAY", "1-1203": "SALDO_SHOPEE" };
const coaName = (bankName: string) => bankName.replace(/\s*-\s*/g, " ").replace(/\s{2,}/g, " ").trim();
const last4 = (name: string) => name.match(/(\d{4})\s*$/)?.[1] ?? null;

async function nextCashCode(tx: Tx) {
  const used = new Set((await tx.coaAccount.findMany({ where: { code: { startsWith: "1-12" } }, select: { code: true } })).map((a) => a.code));
  for (let n = 1204; n < 1300; n++) if (!used.has(`1-${n}`)) return `1-${n}`;
  throw new Error("Kode akun 1-12xx penuh");
}

async function run(tx: Tx) {
  const log: string[] = [];
  const banks = await tx.bankAccount.findMany({ where: { active: true }, include: { coaAccount: true }, orderBy: { code: "asc" } });
  const byCoa = new Map<string, typeof banks>();
  for (const b of banks) byCoa.set(b.coaAccountId, [...(byCoa.get(b.coaAccountId) ?? []), b]);

  for (const [coaId, group] of byCoa) {
    if (group.length < 2) continue;
    const coa = group[0].coaAccount;
    const keeper = group.find((b) => b.code === SEED_OWNER[coa.code]) ?? group[0];
    log.push(`\nAkun ${coa.code} ${coa.name} dipakai bersama: ${group.map((b) => `${b.name} (${b.code})`).join(", ")}`);
    log.push(`  tetap di ${coa.code}: ${keeper.name}`);
    if (coaName(keeper.name) !== coa.name && coa.code !== "1-1100") {
      log.push(`  ganti nama akun ${coa.code}: "${coa.name}" -> "${coaName(keeper.name)}"`);
      await tx.coaAccount.update({ where: { id: coaId }, data: { name: coaName(keeper.name) } });
    }
    for (const b of group.filter((x) => x.id !== keeper.id)) {
      const code = await nextCashCode(tx);
      const fresh = await tx.coaAccount.create({ data: { code, name: coaName(b.name), type: "ASET", isCash: true, parentId: coa.parentId } });
      log.push(`  + akun baru ${code} ${fresh.name} untuk rekening ${b.name}`);
      const data: Prisma.BankAccountUpdateInput = { coaAccount: { connect: { id: fresh.id } } };
      const digits = last4(b.name);
      if (digits) {
        const aliases = new Set(b.aliases.split(",").map((a) => a.trim()).filter(Boolean));
        const base = b.name.replace(/\s*-?\s*\d{4}\s*$/, "").trim().toLowerCase();
        for (const a of [digits, `${base} ${digits}`]) aliases.add(a);
        data.aliases = [...aliases].join(",");
      }
      // Kode lama yang tidak ada hubungannya dengan nama (HUTANG untuk "Seabank - 0006") diganti kode otomatis
      const nameKey = b.name.toUpperCase().replace(/[^A-Z0-9]+/g, "");
      if (!b.code.split("_").filter(Boolean).every((w) => nameKey.includes(w))) {
        const expected = await autoCode.bank(tx, b.name);
        log.push(`  kode rekening ${b.code} -> ${expected} (kode lama tidak sesuai nama)`);
        data.code = expected;
      }
      await tx.bankAccount.update({ where: { id: b.id }, data });
      // Pindahkan baris jurnal milik rekening ini
      const moved = await moveLines(tx, b.id, b.name, coaId, fresh.id);
      log.push(`  ${moved.ids.length} baris jurnal dipindah ke ${code}${moved.ids.length ? ` (${moved.journals.join(", ")})` : ""}`);
      if (digits) log.push(`  alias ditambah: ${digits}`);
    }
    // Baris yang tersisa di akun lama tapi asalnya tidak bisa dipastikan
    const unknown = await unresolved(tx, coaId);
    if (unknown.length) log.push(`  PERIKSA: ${unknown.length} jurnal lain di ${coa.code} dianggap milik ${keeper.name}: ${unknown.slice(0, 15).join(", ")}${unknown.length > 15 ? " ..." : ""}`);
  }
  if (!log.length) log.push("Semua rekening aktif sudah memakai akun COA sendiri-sendiri. Tidak ada yang diubah.");
  return log;
}

/** Cari baris jurnal di akun lama yang pasti milik rekening `bankId` */
async function moveLines(tx: Tx, bankId: string, bankName: string, fromCoa: string, toCoa: string) {
  const ids: string[] = [];
  const journals = new Set<string>();
  const take = async (journalId: string | null | undefined, side: "debit" | "credit" | "any", memo?: (m: string | null) => boolean) => {
    if (!journalId) return;
    const lines = await tx.journalLine.findMany({ where: { journalId, accountId: fromCoa }, include: { journal: true } });
    for (const l of lines) {
      if (side === "debit" && !(l.debit > BigInt(0))) continue;
      if (side === "credit" && !(l.credit > BigInt(0))) continue;
      if (memo && !memo(l.memo)) continue;
      if (!ids.includes(l.id)) {
        ids.push(l.id);
        journals.add(l.journal.number);
      }
    }
    // Pembalik jurnal ini ikut pindah dengan sisi yang berlawanan
    const rev = await tx.journal.findFirst({ where: { reversalOfId: journalId } });
    if (rev) await take(rev.id, side === "debit" ? "credit" : side === "credit" ? "debit" : "any", memo);
  };

  for (const t of await tx.financeTransaction.findMany({ where: { journalId: { not: null }, OR: [{ accountId: bankId }, { toAccountId: bankId }] } })) {
    if (t.direction === "TRANSFER") await take(t.journalId, t.toAccountId === bankId ? "debit" : "credit");
    else await take(t.journalId, t.direction === "MASUK" ? "debit" : "credit");
  }
  for (const f of await tx.reserveFund.findMany({ where: { OR: [{ fromBankId: bankId }, { toBankId: bankId }] }, include: { entries: true } })) {
    for (const e of f.entries) {
      if (e.type === "SISIH") {
        if (f.fromBankId === bankId) await take(e.journalId, "credit");
        if (f.toBankId === bankId) await take(e.journalId, "debit", (m) => m === "Dana disisihkan");
      } else if (f.toBankId === bankId) await take(e.journalId, "credit");
    }
  }
  for (const p of await tx.purchase.findMany({ where: { bankAccountId: bankId } })) await take(p.journalId, "credit");
  for (const s of await tx.boronganSettlement.findMany({ where: { bankAccountId: bankId } })) await take(s.journalId, "credit");
  for (const j of await tx.journal.findMany({ where: { source: "SALDO_AWAL", lines: { some: { accountId: fromCoa, memo: { startsWith: `Saldo ${bankName}:` } } } } })) {
    await take(j.id, "any", (m) => !!m?.startsWith(`Saldo ${bankName}:`));
  }
  if (ids.length) await tx.journalLine.updateMany({ where: { id: { in: ids } }, data: { accountId: toCoa } });
  return { ids, journals: [...journals] };
}

async function unresolved(tx: Tx, coaId: string) {
  const rows = await tx.journal.findMany({ where: { lines: { some: { accountId: coaId } }, source: { notIn: ["FINANCE", "SISIHAN", "PEMBELIAN", "BORONGAN", "PEMBALIK"] } }, select: { number: true, description: true } });
  return rows.map((r) => `${r.number} ${r.description.slice(0, 40)}`);
}

async function main() {
  const db = new URL(process.env.DATABASE_URL ?? "postgresql://x/x").pathname.slice(1);
  console.log(`Database: ${db}  ·  mode: ${apply ? "JALANKAN" : "pratinjau"}`);
  try {
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`ALTER TABLE "JournalLine" DISABLE TRIGGER journal_line_no_update`);
        const log = await run(tx);
        await tx.$executeRawUnsafe(`ALTER TABLE "JournalLine" ENABLE TRIGGER journal_line_no_update`);
        console.log(log.join("\n"));
        if (!apply) throw new DryRun();
        await tx.auditLog.create({ data: { actorName: "skrip pisahkan-coa-rekening", action: "COA_REKENING_DIPISAH", entity: "BankAccount", data: { log } } });
      },
      { timeout: 5 * 60_000 },
    );
    console.log("\nSelesai. Cek Akuntansi › Atur saldo rekening: saldo tiap rekening sekarang terpisah.");
  } catch (e) {
    if (e instanceof DryRun) console.log("\nIni baru PRATINJAU. Untuk menyimpan: npm run backup  lalu  npm run pisahkan:rekening -- --jalankan");
    else throw e;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
