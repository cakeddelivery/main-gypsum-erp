import { prisma } from "./db";
import { type SplitInput, createTransaction, missingFields, splitIssues, STATUS_LABEL } from "./finance";
import { matchStore } from "./extract";
import { originLabel } from "./txMirror";
import type { CatSuggestion } from "./categorySuggest";
import { esc, sendTelegram, type InlineButton } from "./telegram";
import { idr } from "./money";
import { addDays, fmtDate, fmtDateTime, todayStr } from "./time";
import { isTiktokSeller } from "./wdProcess";
import type { SellerWithdrawal } from "./wdProof";

/**
 * Draft transaksi dari pesan/foto bot: membuat draft (setelah cek transaksi mirip) dan kartu draft bertombol.
 * Dipisah dari bot.ts agar isian bertahap (botFlow3) bisa membuat draft tanpa impor melingkar.
 */
export type DraftIdent = { userId: string; telegramUserId?: string; user: { name: string } };

export type Pick = "acc" | "to" | "cat" | "st" | "dt" | `s${number}`;

/**
 * Ringkasan draft + tombol interaktif: data yang kurang langsung diberi pilihan (rekening, tujuan, kategori, toko),
 * transaksi yang dicurigai duplikat menampilkan transaksi sebelumnya, dan data yang sudah terisi tetap bisa diganti.
 * `pick` = tampilkan pilihan untuk mengganti field tsb (tombol 🏦 / 🏷️ / 🏪).
 */
export async function draftMessage(txId: string, pick?: Pick): Promise<{ text: string; buttons: InlineButton[][] }> {
  const t = await prisma.financeTransaction.findUniqueOrThrow({ where: { id: txId }, include: { splits: { orderBy: { sortOrder: "asc" } } } });
  const splitItems = await prisma.item.findMany({ where: { id: { in: t.splits.map((x) => x.itemId).filter((x): x is string => !!x) } }, select: { id: true, name: true, unit: true } });
  const [banks, cats, stores, dup] = await Promise.all([
    prisma.bankAccount.findMany({ where: { active: true }, orderBy: { code: "asc" } }),
    prisma.txCategory.findMany({ where: { active: true, direction: t.direction }, orderBy: { name: "asc" } }),
    prisma.store.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
    t.duplicateOfId ? prisma.financeTransaction.findUnique({ where: { id: t.duplicateOfId } }) : null,
  ]);
  const bank = banks.find((b) => b.id === t.accountId);
  const to = banks.find((b) => b.id === t.toAccountId);
  const cat = cats.find((c) => c.id === t.categoryId);
  const store = stores.find((x) => x.id === t.storeId);
  // Toko hanya relevan untuk withdraw saldo penjual marketplace (WD); tombol Toko hanya bila toko tidak terbaca dari pesan/bukti
  const isWd = t.direction === "TRANSFER" && !!bank?.marketplace;
  const counterparty = (t.aiExtraction as { receipt?: { counterparty?: string } } | null)?.receipt?.counterparty;
  const storeClear = !!store && matchStore([t.rawText, counterparty].filter(Boolean).join(" "), stores) === store.id;
  // WD TikTok: dana baru masuk bank 1–3 hari kemudian → konfirmasi = Dalam Proses, tanggal terima ditanyakan saat "Uang diterima"
  const tiktok = t.direction === "TRANSFER" && isTiktokSeller(bank);
  const dateNeeded = dateUnconfirmed(t) && !tiktok;
  // Screenshot "Detail penarikan dana" Seller Center: Pengajuan = tanggal transfer, Berhasil ditransfer = uang masuk bank
  const sw = (t.aiExtraction as { seller?: SellerWithdrawal } | null)?.seller ?? null;
  const swAt = (x: { date: string; time: string | null } | null) => (x ? `${fmtDate(x.date)}${x.time ? ` ${x.time}` : ""}` : "—");
  const dirOf = (d: string) => (d === "MASUK" ? "Pemasukan" : d === "KELUAR" ? "Pengeluaran" : "Transfer internal");
  const lines = [
    `<b>${esc(t.number)}</b> · ${STATUS_LABEL[t.status]}`,
    `Jenis: ${dirOf(t.direction)}`,
    `Nominal: <b>${idr(t.amount)}</b>`,
    `Tanggal: ${fmtDateTime(t.date)}`,
    `Rekening: ${bank ? esc(bank.name) : "— (belum dipilih)"}${t.direction === "TRANSFER" ? ` → ${to ? esc(to.name) : "— (belum dipilih)"}` : ""}`,
    t.direction !== "TRANSFER" && !t.splits.length ? `Kategori: ${cat ? esc(cat.name) : "— (belum dipilih)"}` : "",
    ...(t.splits.length
      ? [
          `Rincian (${t.splits.length}):`,
          ...t.splits.map((x, k) => {
            const it = splitItems.find((i) => i.id === x.itemId);
            const c = cats.find((cc) => cc.id === x.categoryId);
            return `${k + 1}. ${esc(x.note ?? "")} · <b>${idr(x.amount)}</b> → ${it ? `📦 stok ${esc(it.name)} ${Number(x.qty)} ${esc(it.unit)}` : c ? esc(c.name) : "<i>kategori belum dipilih</i>"}`;
          }),
        ]
      : []),
    (isWd && stores.length > 1) || !store ? `Toko: ${store ? esc(store.name) : "— (belum dipilih)"}` : "",
    t.note ? `Catatan: ${esc(t.note.slice(0, 200))}` : "",
    t.direction === "TRANSFER" && bank?.marketplace ? `💰 Withdraw saldo penjual: otomatis dicatat juga sebagai pemasukan penjualan ${idr(t.amount)}${tiktok ? " saat uangnya diterima" : ""}` : "",
    tiktok && t.status === "DALAM_PROSES" ? `⏳ <b>Dalam proses</b>: uang belum masuk ${to ? esc(to.name) : "rekening"}${t.sentAt ? ` (ditransfer ${fmtDateTime(t.sentAt)})` : ""}. Saldo belum berubah.` : "",
    ...(tiktok && sw
      ? [
          `📄 Detail penarikan Seller Center${sw.ref ? ` · No. Ref ${esc(sw.ref)}` : ""}`,
          `Pengajuan: ${swAt(sw.submitted)}`,
          sw.transferred ? `✅ Berhasil ditransfer: <b>${swAt(sw.transferred)}</b> (uang sudah masuk ${to ? esc(to.name) : "rekening"})` : "⏳ Belum \"Berhasil ditransfer\" (masih diproses)",
          sw.last4 && to && !`${to.name} ${to.aliases} ${to.code}`.includes(sw.last4) ? `⚠️ Rekening di bukti ****${esc(sw.last4)} berbeda dengan tujuan ${esc(to.name)}. Periksa lagi.` : "",
        ]
      : []),
    tiktok && !sw?.transferred && ["DRAFT", "PERLU_DITINJAU", "MENUNGGU_KONFIRMASI"].includes(t.status) ? "⏳ Dana WD TikTok baru masuk bank 1–3 hari setelah ditransfer. Bila belum masuk, konfirmasi dulu (Dalam Proses), lalu tekan 💰 Uang diterima saat sudah masuk (atau kirim screenshot \"Berhasil ditransfer\")." : "",
    dateNeeded ? "📅 <b>Bukti withdraw tidak mencantumkan tanggal.</b> Pastikan tanggal dana masuk ke rekening sebelum dibukukan." : "",
  ].filter(Boolean);
  if (dup) {
    lines.push(
      "",
      "⚠️ <b>Mirip transaksi yang sudah ada</b> (nominal & tanggal sama):",
      `<b>${esc(dup.number)}</b> · ${STATUS_LABEL[dup.status]}${dup.origin ? ` · ${esc(originLabel(dup.origin, dup.direction) ?? "")}` : ""}`,
      `${dirOf(dup.direction)} ${idr(dup.amount)} · ${fmtDateTime(dup.date)}`,
      `Rekening: ${esc(banks.find((b) => b.id === dup.accountId)?.name ?? "—")}${dup.direction === "TRANSFER" ? ` → ${esc(banks.find((b) => b.id === dup.toAccountId)?.name ?? "—")}` : ""}${cats.find((c) => c.id === dup.categoryId) ? ` · ${esc(cats.find((c) => c.id === dup.categoryId)!.name)}` : ""}`,
      ...(dup.note ? [`Catatan: ${esc(dup.note.slice(0, 120))}`] : []),
      `Dibuat: ${fmtDateTime(dup.createdAt)}${dup.telegramChatId ? " via Telegram" : ""}${dup.proofPath ? " · ada foto bukti" : ""}`,
    );
  }
  const buttons: InlineButton[][] = [];
  if (t.status === "DITOLAK") lines.push("<i>Draft ditolak (dibuang, tanpa jurnal). Lihat di web: Transaksi → tab Ditolak.</i>");
  if (t.status === "DIBUKUKAN" || t.status === "DITOLAK" || t.status === "DIBATALKAN") return { text: lines.join("\n"), buttons };
  if (t.status === "DALAM_PROSES") return { text: lines.join("\n"), buttons: [[{ text: "💰 Uang diterima", callback_data: `wr:${t.id}` }]] };
  const issues = splitIssues(t.amount, t.direction, t.splits);
  const missing = [...missingFields(t), ...issues];
  const splitSum = t.splits.reduce((a, x) => a + Number(x.amount), 0);
  if (t.splits.length && splitSum !== Number(t.amount)) lines.push(`\n⚠️ Total rincian ${idr(splitSum)} tidak sama dengan nominal ${idr(t.amount)}.`);
  const noCat = t.splits.findIndex((x) => !x.categoryId && !x.itemId);
  // Pilihan untuk data yang kurang (atau yang ingin diganti)
  const need: Pick | null = pick ?? (noCat >= 0 && t.accountId ? (`s${noCat}` as Pick) : null) ?? (!t.accountId ? "acc" : t.direction === "TRANSFER" && (!t.toAccountId || t.toAccountId === t.accountId) ? "to" : t.direction !== "TRANSFER" && !t.categoryId ? "cat" : !t.storeId ? "st" : dateNeeded ? "dt" : null);
  if (need === "acc") {
    lines.push(`\n${pick ? "Ganti" : "Pilih"} rekening${t.direction === "TRANSFER" ? " asal" : ""}:`);
    buttons.push(...chunk(banks.map((b) => ({ text: `${b.id === t.accountId ? "✓ " : ""}${b.name}`, callback_data: `acc:${t.id}:${b.id}` })), 2));
  } else if (need === "to") {
    lines.push(`\n${pick ? "Ganti" : "Pilih"} rekening tujuan:`);
    buttons.push(...chunk(banks.filter((b) => b.id !== t.accountId).map((b) => ({ text: `${b.id === t.toAccountId ? "✓ " : ""}${b.name}`, callback_data: `to:${t.id}:${b.id}` })), 2));
  } else if (need === "cat") {
    // Saran kategori (disimpan saat draft dibuat): 1–3 tombol + "Kategori lain"; tidak cocok = usul kategori baru
    const sug = (t.aiExtraction as { catSuggest?: CatSuggestion } | null)?.catSuggest;
    const picks = (sug?.picks ?? []).filter((p) => cats.some((c) => c.id === p.id));
    const proposal = sug?.proposal && !cats.some((c) => c.name.toLowerCase() === sug.proposal!.name.toLowerCase()) ? sug.proposal : null;
    if (!pick && picks.length) {
      lines.push(`\n💡 Saran kategori (${picks.map((p) => p.why).filter((w, k, a) => a.indexOf(w) === k).join(", ")}):`);
      buttons.push(...picks.map((p) => [{ text: `✨ ${p.name}`, callback_data: `cat:${t.id}:${cbId(p.id)}` }]));
      buttons.push([{ text: "📋 Kategori lain", callback_data: `chg:${t.id}:cat` }]);
    } else {
      lines.push(`\n${pick ? "Ganti" : "Pilih"} kategori:`);
      buttons.push(...chunk(cats.slice(0, 40).map((c) => ({ text: `${c.id === t.categoryId ? "✓ " : ""}${c.name}`, callback_data: `cat:${t.id}:${cbId(c.id)}` })), 2));
    }
    if (proposal) {
      lines.push(`➕ Belum ada kategori yang cocok? Usulan: <b>${esc(proposal.name)}</b> (${proposal.coaType === "PENDAPATAN" ? "pendapatan" : proposal.coaType === "HPP" ? "HPP" : "beban"}${proposal.parentLabel ? `, induk ${esc(proposal.parentLabel)}` : ""}). Dibuat setelah disetujui Owner/Finance.`);
      buttons.push([{ text: `➕ Usul kategori baru: ${proposal.name}`.slice(0, 60), callback_data: `kn:${t.id}` }]);
    }
  } else if (need?.startsWith("s") && need !== "st") {
    const k = Number(need.slice(1));
    const sp = t.splits[k];
    if (sp) {
      lines.push(`\n${pick ? "Ganti" : "Pilih"} kategori untuk rincian ${k + 1} (<i>${esc(sp.note ?? "")}</i> ${idr(sp.amount)}):`);
      buttons.push(...chunk(cats.slice(0, 40).map((c) => ({ text: `${c.id === sp.categoryId ? "✓ " : ""}${c.name}`, callback_data: `sc:${t.id}:${k}:${cbId(c.id)}` })), 2));
    }
  } else if (need === "dt") {
    // Tanggal dana masuk: 6 hari terakhir (jam tetap); tanggal lain lewat web
    const today = todayStr();
    lines.push(`\n${pick ? "Ganti" : "Pilih"} tanggal${isWd ? " dana masuk" : ""}:`);
    const days = [0, 1, 2, 3, 4, 5].map((k) => addDays(today, -k));
    buttons.push(...chunk(days.map((d, k) => ({ text: `${k === 0 ? "Hari ini" : k === 1 ? "Kemarin" : fmtDate(d)}${k < 2 ? ` (${fmtDate(d)})` : ""}`, callback_data: `dt:${t.id}:${d.replace(/-/g, "")}` })), 2));
  } else if (need === "st") {
    lines.push(`\n${pick ? "Ganti" : "Pilih"} toko${t.direction === "TRANSFER" && bank?.marketplace ? " untuk withdraw ini (MG / DL)" : ""}:`);
    buttons.push(...chunk(stores.map((x) => ({ text: `${x.id === t.storeId ? "✓ " : ""}${x.name}`, callback_data: `st:${t.id}:${x.id}` })), 2));
  }
  if (pick) {
    buttons.push([{ text: "◀ Kembali", callback_data: `back:${t.id}` }]);
    return { text: lines.join("\n"), buttons };
  }
  if (t.duplicateOfId) {
    lines.push("\nApakah ini transaksi yang sama (terkirim dua kali)?");
    buttons.push([{ text: "✅ Ini transaksi berbeda, tetap simpan", callback_data: `rev:${t.id}` }], [{ text: "🛑 Ini sama, jangan simpan", callback_data: `no:${t.id}` }], [{ text: "🔎 Lihat transaksi lama", callback_data: `dv:${t.id}` }]);
  }
  // Data yang sudah terisi tetap bisa diganti
  const edit: InlineButton[] = [];
  if (t.accountId && need !== "acc") edit.push({ text: "🏦 Rekening", callback_data: `chg:${t.id}:acc` });
  if (t.direction === "TRANSFER" && t.toAccountId && need !== "to") edit.push({ text: "🏦 Tujuan", callback_data: `chg:${t.id}:to` });
  if (t.direction !== "TRANSFER" && t.categoryId && need !== "cat" && !t.splits.length) edit.push({ text: "🏷️ Kategori", callback_data: `chg:${t.id}:cat` });
  t.splits.forEach((x, k) => {
    if (!x.itemId && x.categoryId && need !== `s${k}`) edit.push({ text: `🏷️ Rincian ${k + 1}`, callback_data: `chg:${t.id}:s${k}` });
  });
  if (isWd && stores.length > 1 && t.storeId && !storeClear && need !== "st") edit.push({ text: "🏪 Toko", callback_data: `chg:${t.id}:st` });
  if (need !== "dt") edit.push({ text: "📅 Tanggal", callback_data: `chg:${t.id}:dt` });
  if (edit.length) buttons.push(...chunk(edit, 3));
  if (t.splits.length && splitSum !== Number(t.amount)) buttons.push([{ text: `Pakai total rincian (${idr(splitSum)})`, callback_data: `sa:${t.id}` }]);
  if (t.splits.length) buttons.push([{ text: "🔗 Gabung jadi 1 kategori", callback_data: `sx:${t.id}` }]);
  if (missing.length === 0 && !t.duplicateOfId && tiktok && sw?.transferred) buttons.push([{ text: "✅ Simpan (uang sudah masuk, dibukukan)", callback_data: `ok:${t.id}` }], [{ text: "❌ Tolak", callback_data: `no:${t.id}` }]);
  else if (missing.length === 0 && !t.duplicateOfId && tiktok && sw) buttons.push([{ text: "⏳ Simpan (dalam proses)", callback_data: `ok:${t.id}` }], [{ text: "❌ Tolak", callback_data: `no:${t.id}` }]);
  else if (missing.length === 0 && !t.duplicateOfId && tiktok) buttons.push([{ text: "⏳ Konfirmasi (uang belum masuk)", callback_data: `ok:${t.id}` }], [{ text: "💰 Uang sudah diterima", callback_data: `wr:${t.id}` }, { text: "❌ Tolak", callback_data: `no:${t.id}` }]);
  else if (missing.length === 0 && !t.duplicateOfId && !dateNeeded) buttons.push([{ text: "✅ Konfirmasi & bukukan", callback_data: `ok:${t.id}` }, { text: "❌ Tolak", callback_data: `no:${t.id}` }]);
  else if (!t.duplicateOfId) buttons.push([{ text: "❌ Tolak", callback_data: `no:${t.id}` }]);
  return { text: lines.join("\n"), buttons };
}

/** Draft WD yang tanggalnya tidak terbaca (bukti tanpa tanggal) dan belum dipastikan lewat tombol tanggal */
export function dateUnconfirmed(t: { aiExtraction: unknown }) {
  const ax = t.aiExtraction as { needDate?: boolean; dateOk?: boolean } | null;
  return !!ax?.needDate && !ax.dateOk;
}

/**
 * Telegram membatasi callback_data maks. 64 byte. Id kategori hasil migrasi berupa UUID (36 karakter) sehingga
 * `cat:<id transaksi>:<id kategori>` melebihi batas dan Telegram menolak seluruh pesan (tombol tampak tidak merespons).
 * Cukup kirim 12 karakter terakhir id; dicocokkan kembali dengan resolveCategory.
 */
export function cbId(id: string) {
  return id.slice(-12);
}

export async function resolveCategory(v: string | undefined) {
  if (!v) return null;
  const found = await prisma.txCategory.findMany({ where: { id: { endsWith: v } }, select: { id: true }, take: 2 });
  return found.length === 1 ? found[0].id : null;
}


export function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}


/** Data draft transaksi dari pesan bot (disimpan di sesi pembelian agar bisa dicatat sebagai transaksi biasa) */
export type DraftInput = {
  direction: "MASUK" | "KELUAR" | "TRANSFER";
  amount: number;
  date: string;
  accountId: string | null;
  toAccountId: string | null;
  categoryId: string | null;
  note: string | null;
  rawText: string;
  proofPath: string | null;
  aiExtraction: unknown;
  messageId: string;
  storeId?: string | null;
  askStore?: boolean;
  splits?: SplitInput[];
  withdrawRef?: string | null;
};

export async function createDraft(chatId: string, ident: DraftIdent, d: DraftInput & { dupAckIds?: string[] }) {
  const { transaction } = await createTransaction(
    {
      direction: d.direction,
      amount: d.amount,
      date: new Date(d.date),
      accountId: d.accountId,
      toAccountId: d.toAccountId,
      categoryId: d.categoryId,
      suggestedCategoryId: d.categoryId,
      note: d.note,
      rawText: d.rawText,
      proofPath: d.proofPath,
      proofMime: d.proofPath ? "image/jpeg" : null,
      aiExtraction: d.aiExtraction as object,
      idempotencyKey: `tg:${chatId}:${d.messageId}`,
      telegramChatId: chatId,
      telegramMessageId: d.messageId,
      splits: d.splits,
      storeId: d.storeId ?? null,
      askStore: d.askStore,
      dupAckIds: d.dupAckIds ?? [],
      withdrawRef: d.withdrawRef ?? null,
    },
    "TELEGRAM",
    { id: ident.userId, name: ident.user.name, telegramId: ident.telegramUserId },
  );
  const m = await draftMessage(transaction.id);
  await sendTelegram(chatId, `📝 Draft dibuat (belum dibukukan)\n\n${m.text}`, { buttons: m.buttons, type: "DRAFT" });
}

