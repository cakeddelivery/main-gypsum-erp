import { prisma } from "./db";
import { findSimilar, similarReserveDates, type SimilarHit, type SimilarQuery } from "./similar";
import { STATUS_LABEL } from "./finance";
import { originLabel } from "./txMirror";
import { idr } from "./money";
import { fmtDateTime } from "./time";
import { esc, type InlineButton } from "./telegram";
import type { Prompt, Session } from "./botKit";

/**
 * Kartu konfirmasi transaksi mirip di semua isian bot. Sebelum menyimpan, isian memanggil guardDup: bila ada
 * transaksi mirip yang belum dinyatakan berbeda, langkah isian disimpan (dupStep + jawaban dupV) dan bot bertanya.
 * "Berbeda, tetap simpan" → id-nya dicatat (dupAck) lalu jawaban yang sama diulang, jadi isian lanjut dari titik
 * terakhir. "Sama, jangan simpan" → isian ditutup tanpa menyimpan. Sesi tidak pernah hilang diam-diam.
 */
export const appUrl = () => (process.env.APP_URL || "https://erp.maingypsum.shop").replace(/\/+$/, "");

export function ackIds(s: Session): string[] {
  try {
    return JSON.parse(String(s.data.dupAck ?? "[]")) as string[];
  } catch {
    return [];
  }
}

/** Cek transaksi mirip sebelum menyimpan. true = isian berhenti di kartu konfirmasi (langkah "dup") */
export async function guardDup(s: Session, v: string, q: SimilarQuery & { reserveParts?: { fundId: string; date: string }[] }): Promise<boolean> {
  const ack = ackIds(s);
  let hits = await findSimilar(prisma, { ...q, excludeIds: [...(q.excludeIds ?? []), ...ack] });
  if (q.reserveParts?.length) {
    for (const h of await similarReserveDates(prisma, q.reserveParts)) if (!ack.includes(h.id) && !hits.some((x) => x.id === h.id)) hits.push(h);
  }
  hits = hits.slice(0, 3);
  if (!hits.length) return false;
  s.data.dupIds = JSON.stringify(hits.map((h) => h.id));
  s.data.dupStep = s.step;
  s.data.dupV = v;
  s.step = "dup";
  return true;
}

const dirLabel = (d: string) => (d === "MASUK" ? "Masuk" : d === "KELUAR" ? "Keluar" : "Transfer");

async function hitsOf(s: Session) {
  const ids: string[] = JSON.parse(String(s.data.dupIds ?? "[]"));
  const rows = await prisma.financeTransaction.findMany({ where: { id: { in: ids } }, orderBy: { date: "asc" } });
  const banks = await prisma.bankAccount.findMany({ select: { id: true, name: true } });
  const bank = (id: string | null) => banks.find((b) => b.id === id)?.name ?? "—";
  return rows.map((t) => ({ t, line: `<b>${esc(t.number)}</b> · ${STATUS_LABEL[t.status]}${t.origin ? ` · ${esc(originLabel(t.origin, t.direction) ?? "")}` : ""}\n${dirLabel(t.direction)} ${idr(t.amount)} · ${fmtDateTime(t.date)}\nRekening: ${esc(bank(t.accountId))}${t.toAccountId ? ` → ${esc(bank(t.toAccountId))}` : ""}${t.note ? `\n<i>${esc(t.note.slice(0, 100))}</i>` : ""}` }));
}

export function dupButtons(prefix = "f:"): InlineButton[][] {
  return [
    [{ text: "✅ Ini transaksi berbeda, tetap simpan", callback_data: `${prefix}dupok` }],
    [{ text: "🛑 Ini sama, jangan simpan", callback_data: `${prefix}dupno` }],
    [{ text: "🔎 Lihat transaksi lama", callback_data: `${prefix}dupv` }],
  ];
}

export async function dupPrompt(s: Session, detail = false): Promise<Prompt> {
  const hits = await hitsOf(s);
  const head = `⚠️ <b>Mirip transaksi yang sudah ada</b> (nominal & tanggal sama). Belum disimpan.`;
  if (!detail) return { text: `${head}\n\n${hits.map((h) => h.line).join("\n\n")}\n\nApakah ini transaksi yang berbeda?`, buttons: dupButtons() };
  const more = await Promise.all(
    hits.map(async ({ t, line }) => {
      const log = await prisma.approvalLog.findFirst({ where: { transactionId: t.id, action: "DIBUAT" } });
      return `${line}\nDibuat ${fmtDateTime(t.createdAt)} oleh ${esc(log?.actorName ?? t.createdBy)}${t.telegramChatId ? " via Telegram" : ""}${t.proofPath ? " · ada foto bukti" : ""}\n${appUrl()}/finance/${t.id}`;
    }),
  );
  return { text: `${head}\n\n${more.join("\n\n")}`, buttons: [...dupButtons().slice(0, 2), [{ text: "◀ Kembali", callback_data: "f:dupback" }]] };
}

export type DupChoice = "replay" | "stop" | "show" | "detail" | null;

/** Jawaban di langkah "dup": replay = lanjutkan jawaban semula (sudah di-ack) */
export function dupAnswer(s: Session, v: string): DupChoice {
  if (v === "dupv") return "detail";
  if (v === "dupback") return "show";
  if (v === "dupno") return "stop";
  if (v !== "dupok") return null;
  const ids: string[] = JSON.parse(String(s.data.dupIds ?? "[]"));
  s.data.dupAck = JSON.stringify([...new Set([...ackIds(s), ...ids])]);
  s.step = String(s.data.dupStep ?? "confirm");
  s.data.dupIds = null;
  return "replay";
}

export type { SimilarHit };
