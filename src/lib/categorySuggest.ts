import type { AccountType, Prisma, Role, TxDirection } from "@prisma/client";
import { prisma } from "./db";
import { autoCode } from "./codes";
import { audit } from "./audit";
import { FinanceError } from "./finance";
import { tokens, overlap } from "./similar";
import { keywordHit } from "./extract";

/**
 * Saran kategori untuk transaksi baru (bot), berurutan: kata kunci kategori → riwayat transaksi serupa (pihak /
 * keterangan) → AI bila tersedia (boleh gagal / kuota habis; saran tetap jalan tanpa AI).
 * Bila tidak ada yang cocok: usulan kategori baru (nama + jenis + akun induk COA). Kategori baru hanya dibuat setelah
 * Owner/Finance menekan Setujui; kode akun dibuat otomatis (codes.ts).
 */
type Db = Prisma.TransactionClient | typeof prisma;

export type CatPick = { id: string; name: string; why: "kata kunci" | "riwayat" | "AI" };
export type CatProposal = { name: string; direction: "MASUK" | "KELUAR"; coaType: AccountType; parentCoaId: string | null; parentLabel: string | null; keywords: string };
export type CatSuggestion = { picks: CatPick[]; proposal: CatProposal | null };

export const APPROVER_ROLES: Role[] = ["OWNER", "FINANCE"];
export const canApproveCategory = (role: Role) => APPROVER_ROLES.includes(role);

const NOISE = /\b(rp\.?|\d[\d.,]*\s*(rb|ribu|k|jt|juta)?|bayar|beli|membeli|belanja|untuk|dari|ke|via|pakai|transfer|tf|kirim|keluar|masuk|terima|hari ini|kemarin|lunas|tunai|seabank|shopeepay|shopee|tiktok|dana|bca|bri|bni|mandiri|ovo|gopay|main\s*gypsum|dunia\s*lukis|dan|yang|buat|biaya|ongkos)\b/gi;

/** Nama kategori usulan dari keterangan: 1–3 kata pertama yang bermakna, huruf besar di awal kata */
export function proposalName(text: string) {
  const words = text
    .replace(NOISE, " ")
    .replace(/[^A-Za-z ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3)
    .slice(0, 3);
  if (!words.length) return null;
  return words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}

/** Kategori dengan kata kunci / nama yang muncul di keterangan (urut skor) */
function byKeyword(text: string, direction: TxDirection, cats: { id: string; name: string; keywords: string; direction: TxDirection }[]) {
  const t = ` ${text.toLowerCase()} `;
  return cats
    .filter((c) => c.direction === direction)
    .map((c) => {
      const kws = [c.name, ...c.keywords.split(",")].map((k) => k.trim().toLowerCase()).filter((k) => k.length >= 3);
      return { c, score: kws.reduce((s, k) => s + (keywordHit(t, k) ? k.length : 0), 0) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.c);
}

/** Kategori yang paling sering dipakai transaksi dibukukan dengan pihak / keterangan mirip */
async function byHistory(db: Db, text: string, direction: TxDirection) {
  const q = tokens(text);
  if (!q.size) return [];
  const rows = await db.financeTransaction.findMany({
    where: { status: "DIBUKUKAN", origin: null, direction, categoryId: { not: null } },
    orderBy: { date: "desc" },
    take: 500,
    select: { categoryId: true, note: true, counterparty: true, rawText: true },
  });
  const score = new Map<string, number>();
  for (const r of rows) {
    const n = overlap(q, tokens([r.note, r.counterparty, r.rawText].filter(Boolean).join(" ")));
    if (n > 0) score.set(r.categoryId!, (score.get(r.categoryId!) ?? 0) + n);
  }
  return [...score].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

async function byAi(text: string, direction: TxDirection, cats: { name: string }[]): Promise<{ pick: string | null; name: string | null; type: AccountType | null } | null> {
  try {
    const { aiConfigured, aiText, modelFor, parseJsonObject } = await import("./ai");
    if (!aiConfigured()) return null;
    const ask = aiText({
      model: modelFor("ADVISOR_MODEL"),
      maxTokens: 200,
      system: "Anda akuntan UMKM kerajinan gypsum. Jawab hanya JSON.",
      text: `Transaksi ${direction === "MASUK" ? "uang masuk" : "uang keluar"}: "${text.slice(0, 300)}".\nDaftar kategori: ${cats.map((c) => c.name).join("; ")}.\nPilih satu kategori yang PALING cocok dari daftar (nama persis). Bila tidak ada yang cocok, isi "kategori": null dan usulkan kategori baru singkat (maks 4 kata) beserta jenis akunnya (BEBAN, HPP untuk bahan produksi, atau PENDAPATAN).\nFormat: {"kategori": "..." | null, "baru": {"nama": "...", "jenis": "BEBAN"} | null}`,
    });
    const out = await Promise.race([ask, new Promise<null>((r) => setTimeout(() => r(null), 10_000))]);
    if (!out) return null;
    const j = parseJsonObject<{ kategori?: string | null; baru?: { nama?: string; jenis?: string } | null }>(out);
    if (!j) return null;
    const type = ["BEBAN", "HPP", "PENDAPATAN"].includes(j.baru?.jenis ?? "") ? (j.baru!.jenis as AccountType) : null;
    return { pick: j.kategori ?? null, name: j.baru?.nama?.trim().slice(0, 40) || null, type };
  } catch {
    return null;
  }
}

/** Akun induk untuk kategori baru: akun "lain-lain" sesuai jenis (6-9000 / 4-9000 / 5-1000) */
async function parentFor(db: Db, type: AccountType) {
  const code = type === "PENDAPATAN" ? "4-9000" : type === "HPP" ? "5-1000" : "6-9000";
  return db.coaAccount.findUnique({ where: { code } });
}

export async function suggestCategories(db: Db, input: { direction: TxDirection; text: string }, opts: { ai?: boolean } = {}): Promise<CatSuggestion> {
  if (input.direction === "TRANSFER") return { picks: [], proposal: null };
  const cats = await db.txCategory.findMany({ where: { active: true }, select: { id: true, name: true, keywords: true, direction: true } });
  const own = cats.filter((c) => c.direction === input.direction);
  const picks: CatPick[] = [];
  const add = (id: string, why: CatPick["why"]) => {
    const c = own.find((x) => x.id === id);
    if (c && !picks.some((p) => p.id === id) && picks.length < 3) picks.push({ id: c.id, name: c.name, why });
  };
  for (const c of byKeyword(input.text, input.direction, cats)) add(c.id, "kata kunci");
  for (const id of await byHistory(db, input.text, input.direction)) add(id, "riwayat");
  let aiName: string | null = null;
  let aiType: AccountType | null = null;
  if (!picks.length && opts.ai) {
    const r = await byAi(input.text, input.direction, own);
    const hit = r?.pick ? own.find((c) => c.name.toLowerCase() === r.pick!.toLowerCase()) : null;
    if (hit) add(hit.id, "AI");
    aiName = r?.name ?? null;
    aiType = r?.type ?? null;
  }
  if (picks.length) return { picks, proposal: null };
  const name = aiName ?? proposalName(input.text);
  if (!name || own.some((c) => c.name.toLowerCase() === name.toLowerCase())) return { picks, proposal: null };
  const coaType: AccountType = input.direction === "MASUK" ? "PENDAPATAN" : aiType === "HPP" ? "HPP" : "BEBAN";
  const parent = await parentFor(db, coaType);
  return { picks, proposal: { name, direction: input.direction, coaType, parentCoaId: parent?.id ?? null, parentLabel: parent ? `${parent.code} ${parent.name}` : null, keywords: name.toLowerCase() } };
}

/** Catat usulan kategori baru (siapa pun yang boleh mengirim transaksi); belum membuat kategori */
export async function proposeCategory(p: CatProposal, ctx: { transactionId?: string | null; chatId?: string | null }, actor: { id: string; name: string }) {
  const dup = await prisma.categoryProposal.findFirst({ where: { status: "MENUNGGU", name: p.name, direction: p.direction } });
  if (dup) return dup;
  const r = await prisma.categoryProposal.create({
    data: { name: p.name, direction: p.direction, coaType: p.coaType, parentCoaId: p.parentCoaId, keywords: p.keywords, transactionId: ctx.transactionId ?? null, chatId: ctx.chatId ?? null, proposedById: actor.id, proposedBy: actor.name },
  });
  await audit(actor, "KATEGORI_DIUSULKAN", "CategoryProposal", r.id, { name: p.name, direction: p.direction });
  return r;
}

const coaName = (type: AccountType, name: string) =>
  type === "BEBAN" && !/^beban\b/i.test(name) ? `Beban ${name}` : type === "PENDAPATAN" && !/^(pendapatan|penjualan)\b/i.test(name) ? `Pendapatan ${name}` : name;

/** Setujui usulan: HANYA Owner/Finance. Membuat akun COA (kode otomatis) + kategori transaksi */
export async function approveCategoryProposal(id: string, actor: { id: string; name: string; role: Role }) {
  if (!canApproveCategory(actor.role)) throw new FinanceError("Hanya Owner/Finance yang dapat menyetujui kategori baru");
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "CategoryProposal" WHERE id = ${id} FOR UPDATE`;
    const p = await tx.categoryProposal.findUniqueOrThrow({ where: { id } });
    if (p.status !== "MENUNGGU") throw new FinanceError(`Usulan ini sudah ${p.status.toLowerCase()}`);
    const existing = await tx.txCategory.findFirst({ where: { active: true, direction: p.direction, name: { equals: p.name, mode: "insensitive" } } });
    let categoryId = existing?.id;
    let coaCode: string | null = null;
    if (!existing) {
      const code = await autoCode.coa(tx, p.coaType);
      const coa = await tx.coaAccount.create({ data: { code, name: coaName(p.coaType, p.name), type: p.coaType, parentId: p.parentCoaId } });
      const cat = await tx.txCategory.create({ data: { name: p.name, direction: p.direction, coaAccountId: coa.id, keywords: p.keywords } });
      categoryId = cat.id;
      coaCode = code;
    }
    const r = await tx.categoryProposal.update({ where: { id }, data: { status: "DISETUJUI", decidedBy: actor.name, decidedAt: new Date(), categoryId } });
    await audit(actor, "KATEGORI_DISETUJUI", "CategoryProposal", id, { name: p.name, categoryId, coaCode }, tx);
    return { proposal: r, categoryId: categoryId!, coaCode };
  });
}

export async function rejectCategoryProposal(id: string, actor: { id: string; name: string; role: Role }) {
  if (!canApproveCategory(actor.role)) throw new FinanceError("Hanya Owner/Finance yang dapat menolak usulan kategori");
  const p = await prisma.categoryProposal.findUniqueOrThrow({ where: { id } });
  if (p.status !== "MENUNGGU") throw new FinanceError(`Usulan ini sudah ${p.status.toLowerCase()}`);
  const r = await prisma.categoryProposal.update({ where: { id }, data: { status: "DITOLAK", decidedBy: actor.name, decidedAt: new Date() } });
  await audit(actor, "KATEGORI_USULAN_DITOLAK", "CategoryProposal", id, { name: p.name });
  return r;
}
