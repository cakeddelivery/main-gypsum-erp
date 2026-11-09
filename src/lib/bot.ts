import { prisma } from "./db";
import { effectivePermissions } from "./rbac";
import { extractTransaction, hasExplicitAmount, matchStore, mergeReceipt } from "./extract";
import { readReceipt, type ReceiptRead } from "./receipt";
import { ocrReceipt } from "./ocrReceipt";
import { type SplitInput, splitIssues, approveAndBook, createTransaction, FinanceError, rejectTransaction, STATUS_LABEL, submitForConfirmation, updateTransaction, missingFields } from "./finance";
import { answerCallback, chatAction, downloadTelegramFile, editTelegram, esc, sendTelegram, type InlineButton } from "./telegram";
import { saveProof } from "./storage";
import { idr } from "./money";
import { fmtDate, fmtDateTime, jakartaDateTime, txTime } from "./time";
import { dailyRecapText } from "./jobs";
import { handleMenuCallback, handleMenuCommand, MENU_TEXT } from "./botMenu";
import { clearSession, getSession, handleFlowCallback, handleFlowLocation, handleFlowText, startPrefilledFlow, type TgLocation } from "./botFlow";
import { detectPurchase, extractSplits, rawMaterials } from "./botPurchase";
import { prefilledPayablePayment, prefilledPurchase, prefilledReserve, prefilledTalangan, talanganPhoto } from "./botFlow3";
import { talanganSummary } from "./talangan";
import { salePaymentPhoto } from "./botSales";
import { detectPayablePayment } from "./botPurchase";
import { openPayables } from "./payables";
import { matchReserveTransfer } from "./reserve";
import { supplierKey, supplierNames } from "./suppliers";

type TgUser = { id: number; first_name?: string; username?: string };
type TgUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    date?: number;
    chat: { id: number };
    from?: TgUser;
    text?: string;
    caption?: string;
    photo?: { file_id: string; file_size?: number }[];
    location?: TgLocation;
    venue?: unknown;
    forward_origin?: unknown;
    forward_date?: number;
  };
  callback_query?: { id: string; from: TgUser; data?: string; message?: { message_id: number; chat: { id: number } } };
};

async function identityOf(tgId: number) {
  const ident = await prisma.telegramIdentity.findUnique({ where: { telegramUserId: String(tgId) }, include: { user: true } });
  if (!ident || !ident.active || !ident.user.active) return null;
  const overrides = await prisma.rolePermission.findMany({ where: { role: ident.user.role } });
  const perms = effectivePermissions(ident.user.role, overrides);
  return { ...ident, perms };
}

type Pick = "acc" | "to" | "cat" | "st" | `s${number}`;

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
    t.direction === "TRANSFER" && bank?.marketplace ? `💰 Withdraw saldo penjual: otomatis dicatat juga sebagai pemasukan penjualan ${idr(t.amount)}` : "",
  ].filter(Boolean);
  if (dup) {
    lines.push(
      "",
      "⚠️ <b>Mirip transaksi sebelumnya</b> (nominal & tanggal sama):",
      `<b>${esc(dup.number)}</b> · ${STATUS_LABEL[dup.status]}`,
      `${dirOf(dup.direction)} ${idr(dup.amount)} · ${fmtDateTime(dup.date)}`,
      `Rekening: ${esc(banks.find((b) => b.id === dup.accountId)?.name ?? "—")}${dup.direction === "TRANSFER" ? ` → ${esc(banks.find((b) => b.id === dup.toAccountId)?.name ?? "—")}` : ""}${cats.find((c) => c.id === dup.categoryId) ? ` · ${esc(cats.find((c) => c.id === dup.categoryId)!.name)}` : ""}`,
      ...(dup.note ? [`Catatan: ${esc(dup.note.slice(0, 120))}`] : []),
      `Dibuat: ${fmtDateTime(dup.createdAt)}${dup.telegramChatId ? " via Telegram" : ""}${dup.proofPath ? " · ada foto bukti" : ""}`,
    );
  }
  const buttons: InlineButton[][] = [];
  if (t.status === "DITOLAK") lines.push("<i>Draft ditolak (dibuang, tanpa jurnal). Lihat di web: Transaksi → tab Ditolak.</i>");
  if (t.status === "DIBUKUKAN" || t.status === "DITOLAK" || t.status === "DIBATALKAN") return { text: lines.join("\n"), buttons };
  const issues = splitIssues(t.amount, t.direction, t.splits);
  const missing = [...missingFields(t), ...issues];
  const splitSum = t.splits.reduce((a, x) => a + Number(x.amount), 0);
  if (t.splits.length && splitSum !== Number(t.amount)) lines.push(`\n⚠️ Total rincian ${idr(splitSum)} tidak sama dengan nominal ${idr(t.amount)}.`);
  const noCat = t.splits.findIndex((x) => !x.categoryId && !x.itemId);
  // Pilihan untuk data yang kurang (atau yang ingin diganti)
  const need: Pick | null = pick ?? (noCat >= 0 && t.accountId ? (`s${noCat}` as Pick) : null) ?? (!t.accountId ? "acc" : t.direction === "TRANSFER" && (!t.toAccountId || t.toAccountId === t.accountId) ? "to" : t.direction !== "TRANSFER" && !t.categoryId ? "cat" : !t.storeId ? "st" : null);
  if (need === "acc") {
    lines.push(`\n${pick ? "Ganti" : "Pilih"} rekening${t.direction === "TRANSFER" ? " asal" : ""}:`);
    buttons.push(...chunk(banks.map((b) => ({ text: `${b.id === t.accountId ? "✓ " : ""}${b.name}`, callback_data: `acc:${t.id}:${b.id}` })), 2));
  } else if (need === "to") {
    lines.push(`\n${pick ? "Ganti" : "Pilih"} rekening tujuan:`);
    buttons.push(...chunk(banks.filter((b) => b.id !== t.accountId).map((b) => ({ text: `${b.id === t.toAccountId ? "✓ " : ""}${b.name}`, callback_data: `to:${t.id}:${b.id}` })), 2));
  } else if (need === "cat") {
    lines.push(`\n${pick ? "Ganti" : "Pilih"} kategori:`);
    buttons.push(...chunk(cats.slice(0, 40).map((c) => ({ text: `${c.id === t.categoryId ? "✓ " : ""}${c.name}`, callback_data: `cat:${t.id}:${cbId(c.id)}` })), 2));
  } else if (need?.startsWith("s") && need !== "st") {
    const k = Number(need.slice(1));
    const sp = t.splits[k];
    if (sp) {
      lines.push(`\n${pick ? "Ganti" : "Pilih"} kategori untuk rincian ${k + 1} (<i>${esc(sp.note ?? "")}</i> ${idr(sp.amount)}):`);
      buttons.push(...chunk(cats.slice(0, 40).map((c) => ({ text: `${c.id === sp.categoryId ? "✓ " : ""}${c.name}`, callback_data: `sc:${t.id}:${k}:${cbId(c.id)}` })), 2));
    }
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
    buttons.push([{ text: "✅ Bukan duplikat, lanjutkan", callback_data: `rev:${t.id}` }], [{ text: "🗑 Ya duplikat, batalkan ini", callback_data: `no:${t.id}` }]);
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
  if (edit.length) buttons.push(...chunk(edit, 3));
  if (t.splits.length && splitSum !== Number(t.amount)) buttons.push([{ text: `Pakai total rincian (${idr(splitSum)})`, callback_data: `sa:${t.id}` }]);
  if (t.splits.length) buttons.push([{ text: "🔗 Gabung jadi 1 kategori", callback_data: `sx:${t.id}` }]);
  if (missing.length === 0 && !t.duplicateOfId) buttons.push([{ text: "✅ Konfirmasi & bukukan", callback_data: `ok:${t.id}` }, { text: "❌ Tolak", callback_data: `no:${t.id}` }]);
  else if (!t.duplicateOfId) buttons.push([{ text: "❌ Tolak", callback_data: `no:${t.id}` }]);
  return { text: lines.join("\n"), buttons };
}

/**
 * Telegram membatasi callback_data maks. 64 byte. Id kategori hasil migrasi berupa UUID (36 karakter) sehingga
 * `cat:<id transaksi>:<id kategori>` melebihi batas dan Telegram menolak seluruh pesan (tombol tampak tidak merespons).
 * Cukup kirim 12 karakter terakhir id; dicocokkan kembali dengan resolveCategory.
 */
function cbId(id: string) {
  return id.slice(-12);
}

async function resolveCategory(v: string | undefined) {
  if (!v) return null;
  const found = await prisma.txCategory.findMany({ where: { id: { endsWith: v } }, select: { id: true }, take: 2 });
  return found.length === 1 ? found[0].id : null;
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(msg)), ms)))]).finally(() => clearTimeout(timer));
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/** Proses update dari Telegram Bot API (webhook). Tidak pernah membukukan tanpa tombol konfirmasi manusia berwenang. */
export async function handleTelegramUpdate(u: TgUpdate) {
  if (u.callback_query) return handleCallback(u.callback_query);
  const msg = u.message;
  if (!msg?.from) return;
  const chatId = String(msg.chat.id);
  const text = (msg.text ?? msg.caption ?? "").trim();
  const ident = await identityOf(msg.from.id);

  if (text === "/start" || text === "/id") {
    await sendTelegram(chatId, `Halo! ID Telegram Anda: <code>${msg.from.id}</code>\n${ident ? `Terhubung sebagai <b>${esc(ident.user.name)}</b>.` : "Belum terdaftar. Minta Owner menautkan ID ini di menu Pengaturan → Telegram & Hermes."}`);
    if (ident && !ident.chatId) await prisma.telegramIdentity.update({ where: { id: ident.id }, data: { chatId } });
    if (ident && text === "/start") await handleMenuCommand(ident, chatId, "/menu");
    return;
  }
  if (!ident) {
    await sendTelegram(chatId, "Akun Telegram Anda belum diizinkan. Kirim /id lalu minta Owner mendaftarkan ID Anda.");
    return;
  }
  if (!ident.chatId) await prisma.telegramIdentity.update({ where: { id: ident.id }, data: { chatId } });
  // Isian bertahap (produksi, absen, stok): lokasi & jawaban teks
  if (msg.location) {
    await handleFlowLocation(ident, chatId, msg.location, { forwarded: !!(msg.forward_origin || msg.forward_date), venue: !!msg.venue, ageSec: msg.date ? Math.floor(Date.now() / 1000) - msg.date : 0 });
    return;
  }
  // Isian pengembalian dana talangan menunggu foto bukti transfer
  if (msg.photo?.length) {
    const s = await getSession(chatId);
    if (s?.flow === "tlg" && s.step === "proof" && s.userId === ident.userId) {
      const photo = await downloadTelegramFile(msg.photo[msg.photo.length - 1].file_id);
      if (!photo) {
        await sendTelegram(chatId, "Foto gagal diunduh, coba kirim ulang.");
        return;
      }
      await chatAction(chatId, "typing").catch(() => {});
      return startPrefilledFlow({ i: ident, chatId }, await talanganPhoto({ i: ident, chatId }, s, photo, String(msg.message_id)));
    }
    // Isian cicilan piutang penjualan menunggu foto bukti (opsional)
    if (s?.flow === "jcil" && s.step === "proof" && s.userId === ident.userId) {
      const photo = await downloadTelegramFile(msg.photo[msg.photo.length - 1].file_id);
      if (!photo) {
        await sendTelegram(chatId, "Foto gagal diunduh, coba kirim ulang.");
        return;
      }
      return startPrefilledFlow({ i: ident, chatId }, await salePaymentPhoto(s, photo));
    }
  }
  if (text === MENU_TEXT || (text.startsWith("/") && text !== "/batal")) await clearSession(chatId);
  else if (text && !msg.photo && (await handleFlowText(ident, chatId, text))) return;
  if (await handleMenuCommand(ident, chatId, text)) return;
  if (text === "/rekap") {
    // Rekap berisi saldo rekening & arus kas: sama dengan tombol menu, hanya untuk yang boleh melihat ringkasan keuangan
    if (!ident.perms.has("dashboard.finance")) {
      await sendTelegram(chatId, "Anda tidak berwenang melihat rekap keuangan.");
      return;
    }
    await sendTelegram(chatId, await dailyRecapText(new Date()), { type: "REKAP_MANUAL" });
    return;
  }
  if (text === "/bantuan" || text === "/help") {
    await sendTelegram(chatId, "Kirim pesan atau foto bukti transaksi, contoh:\n<i>bayar listrik 350rb dari seabank hari ini</i>\n<i>terima pencairan shopee 1,2jt ke saldo penjual</i>\n<i>transfer internal dari saldo penjual ke seabank 500rb</i>\n\nAtau kirim <b>foto bukti transfer/nota</b> dengan caption keterangan saja, misal <i>beli cat supplier A</i>. Nominal, tanggal & rekening dibaca dari foto.\n\nSaya akan membuat DRAFT dan meminta konfirmasi.\n\n/menu untuk menu tombol (ringkasan & unduh laporan JPG), /rekap untuk rekap harian.");
    return;
  }
  // Pesan/foto bebas menjadi draft transaksi: wajib izin kirim di Telegram DAN izin input transaksi di perannya
  if (!ident.canSubmit || !ident.perms.has("finance.create")) {
    await sendTelegram(chatId, "Anda tidak memiliki izin mengirim transaksi. Gunakan /menu untuk fitur yang tersedia.");
    return;
  }
  if (!text && !msg.photo) return;

  let proofPath: string | null = null;
  let photo: Buffer | null = null;
  if (msg.photo?.length) {
    const largest = msg.photo[msg.photo.length - 1];
    photo = await downloadTelegramFile(largest.file_id);
    if (photo) proofPath = await saveProof(photo, "image/jpeg").catch(() => null);
  }
  const [banks, cats] = await Promise.all([prisma.bankAccount.findMany({ where: { active: true } }), prisma.txCategory.findMany({ where: { active: true } })]);
  let ex = extractTransaction(text || "foto bukti", banks, cats);
  // Foto bukti + caption keterangan: nominal, tanggal & rekening dibaca dari foto
  let receipt: ReceiptRead | null = null;
  // Nominal dari caption hanya dipercaya bila ditulis jelas (Rp/rb/jt); angka lain bisa jumlah barang atau tahun
  // Rincian per baris ("dus bekas 5k / galon 20k / ongkir 10k"): nominal total diambil dari bukti transfer
  const materials = await rawMaterials();
  let splits = extractSplits(text, cats, materials, ex.direction);
  if (photo && (splits.length || !hasExplicitAmount(text) || !ex.direction || !ex.accountId)) {
    await chatAction(chatId, "typing").catch(() => {});
    // Batasi waktu baca AI agar balasan tidak tertahan (Nginx/Telegram memutus permintaan yang terlalu lama)
    receipt = await withTimeout(readReceipt(photo, text, banks), 35_000, "AI membaca foto terlalu lama").catch((e) => {
      console.error("readReceipt:", e instanceof Error ? e.message : e);
      return null;
    });
    // AI tidak terpasang / kuota habis / tidak menemukan nominal → baca foto dengan OCR di server
    if (!receipt?.amount || !receipt.direction || !receipt.account) {
      const ocr = await withTimeout(ocrReceipt(photo, banks), 20_000, "OCR terlalu lama").catch((e) => {
        console.error("ocrReceipt:", e instanceof Error ? e.message : e);
        return null;
      });
      if (ocr) receipt = receipt ? { ...ocr, ...Object.fromEntries(Object.entries(receipt).filter(([, v]) => v != null)) } : ocr;
    }
  }
  ex = mergeReceipt(ex, text, receipt, banks, cats);
  if (splits.length) {
    splits = extractSplits(text, cats, materials, ex.direction ?? "KELUAR");
    if (splits.length) {
      ex.direction = ex.direction ?? "KELUAR";
      ex.amount = receipt?.amount ?? splits.reduce((t, x) => t + x.amount, 0);
    }
  }
  if (!ex.amount || !ex.direction) {
    await sendTelegram(chatId, `Saya belum bisa membaca ${!ex.amount ? "nominal" : "jenis transaksi (masuk/keluar/transfer)"} dari ${photo ? "foto & keterangan" : "pesan"} ini. Tulis ulang dengan lebih lengkap, misal: <i>bayar gypsum 2jt dari seabank</i>.`);
    return;
  }
  // Withdraw saldo penjual: toko dibedakan dari inisial MG / DL (atau nama toko); bila tidak ada, ditanyakan
  const seller = ex.direction === "TRANSFER" ? banks.find((b) => b.id === ex.accountId && b.marketplace) : null;
  const stores = seller ? await prisma.store.findMany({ where: { active: true } }) : [];
  const storeId = seller ? matchStore([text, receipt?.counterparty].filter(Boolean).join(" "), stores) : null;
  const draft: DraftInput = {
    direction: ex.direction,
    amount: ex.amount,
    date: jakartaDateTime(ex.date!, txTime(ex.date!, ex.time)).toISOString(),
    accountId: ex.accountId,
    toAccountId: ex.toAccountId,
    categoryId: ex.categoryId,
    note: (text ? ex.note : (receipt?.counterparty ?? "")).slice(0, 500) || null,
    rawText: text,
    proofPath,
    aiExtraction: receipt ? { ...ex, receipt } : ex,
    messageId: String(msg.message_id),
    storeId,
    askStore: !!seller && !storeId,
    splits: splits.length ? splits.map((x) => ({ categoryId: x.itemId ? null : x.categoryId, amount: x.amount, note: x.label, itemId: x.itemId, qty: x.qty })) : undefined,
  };
  const ctx = { i: ident, chatId };
  const basis = [text, receipt?.counterparty].filter(Boolean).join(" ");
  // Transfer ke rekening simpanan sebesar talangan yang belum dikembalikan (atau berketerangan "talangan") = pengembalian talangan
  if (!splits.length && ex.direction === "TRANSFER" && ex.toAccountId && ident.perms.has("finance.approve")) {
    const w = (await talanganSummary()).find((x) => x.bank.id === ex.toAccountId && x.outstanding > 0);
    if (w && (ex.amount === w.outstanding || /\btalangan\b/i.test(basis))) {
      const session = await prefilledTalangan(ctx, { walletId: w.bank.id, proofPath, read: ex.amount, messageId: String(msg.message_id), date: ex.date });
      if (session) return startPrefilledFlow(ctx, session);
    }
  }
  // Bukti transfer dana sisihan (nominal = kelipatan sisihan harian, rekening sesuai alur dana)
  if (!splits.length && (ex.direction === "TRANSFER" || ex.direction === "KELUAR") && ident.perms.has("finance.approve")) {
    const m = await matchReserveTransfer({ amount: ex.amount, fromBankId: ex.accountId, toBankId: ex.direction === "TRANSFER" ? ex.toAccountId : null, date: ex.date!, text: basis });
    if (m) {
      const session = await prefilledReserve(ctx, { options: m.options, sure: m.sure, proofPath, tx: draft });
      if (session) return startPrefilledFlow(ctx, session);
    }
  }
  // Angsuran hutang supplier / cicilan pinjaman ("angsur kardus", "bayar hutang <nama>", nominal = cicilan): langsung ke isian bayar hutang
  if (!splits.length && ex.direction === "KELUAR" && (ident.perms.has("accounting.post") || ident.perms.has("finance.approve"))) {
    const hit = detectPayablePayment(basis, await openPayables(), ex.direction, ex.amount);
    if (hit) {
      const session = await prefilledPayablePayment(ctx, { candidates: hit.matches.map((p) => p.id), amount: ex.amount, bankId: ex.accountId, date: ex.date, time: txTime(ex.date!, ex.time), note: text || null, proofPath, tx: draft });
      if (session) return startPrefilledFlow(ctx, session);
    }
  }
  // Pembelian bahan baku sesuai master data: langsung ke isian Pembelian (stok + hutang/kas), bukan draft biasa
  if (!splits.length && ex.direction === "KELUAR" && ident.perms.has("finance.approve")) {
    const hit = detectPurchase([text, receipt?.counterparty].filter(Boolean).join(" "), materials, ex.direction);
    if (hit) {
      const supplier = await matchSupplier([text, receipt?.counterparty].filter(Boolean).join(" "));
      const session = await prefilledPurchase(
        { i: ident, chatId },
        { item: hit.item, others: hit.others.map((o) => ({ id: o.id, name: o.name })), qty: hit.qty, amount: ex.amount, bankId: ex.accountId, supplier, date: ex.date, time: txTime(ex.date!, ex.time), note: text || null, proofPath, tx: draft },
      );
      if (session) return startPrefilledFlow({ i: ident, chatId }, session);
    }
  }
  await createDraft(chatId, ident, draft);
}

/** Data draft transaksi dari pesan bot (disimpan di sesi pembelian agar bisa dicatat sebagai transaksi biasa) */
type DraftInput = {
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
};

async function createDraft(chatId: string, ident: NonNullable<Awaited<ReturnType<typeof identityOf>>>, d: DraftInput) {
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
    },
    "TELEGRAM",
    { id: ident.userId, name: ident.user.name, telegramId: ident.telegramUserId },
  );
  const m = await draftMessage(transaction.id);
  await sendTelegram(chatId, `📝 Draft dibuat (belum dibukukan)\n\n${m.text}`, { buttons: m.buttons, type: "DRAFT" });
}

/** Supplier yang namanya disebut di caption atau nama penerima di bukti transfer */
async function matchSupplier(text: string) {
  const t = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  const sups = await prisma.supplier.findMany({ where: { active: true }, select: { id: true, name: true, aliases: true } });
  // Nama atau nama lain supplier (setelah digabung), tanpa kata umum "supplier"/"toko"
  const hit = sups
    .map((x) => ({ x, len: Math.max(0, ...supplierNames(x).map(supplierKey).filter((n) => n.length >= 4 && t.includes(` ${n} `)).map((n) => n.length)) }))
    .filter((r) => r.len > 0)
    .sort((a, b) => b.len - a.len)[0];
  return hit ? { id: hit.x.id, name: hit.x.name } : null;
}

async function handleCallback(cb: NonNullable<TgUpdate["callback_query"]>) {
  const [action, txId, value] = (cb.data ?? "").split(":");
  const chatId = cb.message ? String(cb.message.chat.id) : null;
  const ident = await identityOf(cb.from.id);
  if (!ident) return answerCallback(cb.id, "ID Telegram Anda belum terdaftar");
  if (action === "f") {
    if (!chatId || !cb.message) return answerCallback(cb.id, "Pesan sudah tidak tersedia, kirim /menu");
    if (cb.data === "f:plain") {
      // Isian pembelian dari pesan → dibatalkan, pesan dicatat sebagai draft transaksi biasa
      const s = await getSession(chatId);
      if (!s?.data.tx || s.userId !== ident.userId) return answerCallback(cb.id, "Isian sudah kedaluwarsa, kirim ulang pesannya");
      await clearSession(chatId);
      await answerCallback(cb.id, "");
      await editTelegram(chatId, cb.message.message_id, "Dicatat sebagai transaksi biasa.", []).catch(() => {});
      return createDraft(chatId, ident, JSON.parse(String(s.data.tx)) as DraftInput);
    }
    try {
      return await handleFlowCallback(ident, cb.id, chatId, cb.message.message_id, cb.data!);
    } catch (e) {
      await prisma.notificationLog.create({ data: { channel: "TELEGRAM", type: "ISIAN", target: chatId, status: "GAGAL", payload: cb.data ?? "", error: (e as Error).message.slice(0, 500) } });
      return answerCallback(cb.id, "Terjadi kesalahan, coba lagi");
    }
  }
  if (action === "m") {
    if (!chatId || !cb.message) return answerCallback(cb.id, "Pesan menu sudah tidak tersedia, kirim /menu");
    try {
      return await handleMenuCallback(ident, cb.id, chatId, cb.message.message_id, cb.data!);
    } catch (e) {
      await prisma.notificationLog.create({ data: { channel: "TELEGRAM", type: "MENU", target: chatId, status: "GAGAL", payload: cb.data ?? "", error: (e as Error).message.slice(0, 500) } });
      return answerCallback(cb.id, "Terjadi kesalahan, coba lagi");
    }
  }
  const actor = { id: ident.userId, name: ident.user.name, telegramId: ident.telegramUserId };
  // Melengkapi/membatalkan draft: hanya identitas yang boleh mengirim transaksi atau peninjau/penyetuju keuangan
  const canReview = ident.perms.has("finance.review") || ident.perms.has("finance.approve");
  if (["acc", "to", "cat", "st", "no", "chg", "sc", "sa", "sx"].includes(action) && !ident.canSubmit && !canReview) return answerCallback(cb.id, "Anda tidak berwenang mengubah transaksi");
  // Tombol ganti (🏦 / 🏷️ / 🏪) / ◀ Kembali: hanya mengganti tampilan pilihan, belum mengubah data
  if (action === "chg" || action === "back") {
    if (!chatId || !cb.message) return answerCallback(cb.id, "Pesan sudah tidak tersedia");
    const m = await draftMessage(txId, action === "chg" && (["acc", "to", "cat", "st"].includes(value) || /^s\d+$/.test(value)) ? (value as Pick) : undefined);
    const r = await editTelegram(chatId, cb.message.message_id, m.text, m.buttons);
    if (!r.ok) {
      await prisma.notificationLog.create({ data: { channel: "TELEGRAM", type: "WEBHOOK", target: chatId, status: "GAGAL", payload: cb.data ?? "", error: (r.error ?? "").slice(0, 500) } });
      return answerCallback(cb.id, "Gagal menampilkan pilihan, coba lagi");
    }
    return answerCallback(cb.id, "");
  }
  if (action === "no" && !canReview) {
    const own = await prisma.approvalLog.findFirst({ where: { transactionId: txId, action: "DIBUAT", actorUserId: ident.userId } });
    if (!own) return answerCallback(cb.id, "Hanya pembuat draft atau peninjau keuangan yang dapat menolak");
  }
  try {
    if (action === "acc") await updateTransaction(txId, { accountId: value }, actor);
    else if (action === "to") await updateTransaction(txId, { toAccountId: value }, actor);
    else if (action === "cat") {
      const catId = await resolveCategory(value);
      if (!catId) return answerCallback(cb.id, "Kategori tidak ditemukan, coba lagi");
      await updateTransaction(txId, { categoryId: catId }, actor);
    }
    else if (action === "st") await updateTransaction(txId, { storeId: value }, actor);
    else if (action === "sc" || action === "sa" || action === "sx") {
      const cur = await prisma.financeTransaction.findUniqueOrThrow({ where: { id: txId }, include: { splits: { orderBy: { sortOrder: "asc" } } } });
      const rows = cur.splits.map((x) => ({ categoryId: x.categoryId, amount: Number(x.amount), note: x.note, itemId: x.itemId, qty: x.qty ? Number(x.qty) : null }));
      if (action === "sc") {
        const k = Number(value);
        const catId = await resolveCategory((cb.data ?? "").split(":")[3]);
        if (!rows[k] || !catId) return answerCallback(cb.id, "Rincian tidak ditemukan");
        rows[k] = { ...rows[k], categoryId: catId, itemId: null, qty: null };
        await updateTransaction(txId, { splits: rows, categoryId: null }, actor);
      } else if (action === "sa") await updateTransaction(txId, { amount: rows.reduce((a, x) => a + x.amount, 0) }, actor);
      else await updateTransaction(txId, { splits: [] }, actor);
    }
    else if (action === "rev") {
      if (!ident.perms.has("finance.review")) return answerCallback(cb.id, "Anda tidak berwenang meninjau");
      await prisma.$transaction(async (tx) => {
        const cur = await tx.financeTransaction.findUniqueOrThrow({ where: { id: txId } });
        if (cur.status !== "PERLU_DITINJAU") throw new FinanceError("Transaksi tidak dalam status Perlu Ditinjau");
        await tx.financeTransaction.update({ where: { id: txId }, data: { duplicateOfId: null } });
        await tx.approvalLog.create({ data: { transactionId: txId, action: "BUKAN_DUPLIKAT", fromStatus: cur.status, toStatus: cur.status, actorUserId: actor.id, actorName: actor.name, viaTelegramId: actor.telegramId, note: "Ditandai bukan duplikat via Telegram" } });
      });
    } else if (action === "no") {
      await rejectTransaction(txId, actor, "Ditolak via Telegram");
    } else if (action === "ok") {
      // Konfirmasi wajib dari identitas Telegram terpetakan yang memiliki izin
      if (!ident.canConfirm || !ident.perms.has("finance.approve")) return answerCallback(cb.id, "Anda tidak berwenang mengonfirmasi pembukuan");
      const t = await prisma.financeTransaction.findUniqueOrThrow({ where: { id: txId } });
      if (t.status === "PERLU_DITINJAU" || t.status === "DRAFT") await submitForConfirmation(txId, actor, "Dikonfirmasi via Telegram");
      await approveAndBook(txId, actor, "Dikonfirmasi via Telegram");
    } else return answerCallback(cb.id, "Aksi tidak dikenal");
    // Setelah data dilengkapi, kembalikan ke Menunggu Konfirmasi bila sudah lengkap
    if (["acc", "to", "cat", "st", "rev", "sc", "sa", "sx"].includes(action)) {
      const t = await prisma.financeTransaction.findUniqueOrThrow({ where: { id: txId } });
      const sp = await prisma.financeTxSplit.findMany({ where: { transactionId: txId } });
      if (t.status === "PERLU_DITINJAU" && !t.duplicateOfId && missingFields(t).length === 0 && splitIssues(t.amount, t.direction, sp).length === 0) await submitForConfirmation(txId, actor, "Dilengkapi via Telegram");
    }
    const m = await draftMessage(txId);
    if (chatId && cb.message) await editTelegram(chatId, cb.message.message_id, m.text, m.buttons);
    return answerCallback(cb.id, action === "ok" ? "Dibukukan ✅" : action === "no" ? "Ditolak (dibuang)" : "Tersimpan");
  } catch (e) {
    return answerCallback(cb.id, e instanceof FinanceError ? e.message : "Terjadi kesalahan");
  }
}
