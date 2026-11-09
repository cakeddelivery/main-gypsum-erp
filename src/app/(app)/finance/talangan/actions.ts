"use server";
import { action, int, optStr, str } from "@/lib/action";
import { saveProof } from "@/lib/storage";
import { markTalanganRepay, readProofAmount, repayTalangan } from "@/lib/talangan";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { todayStr } from "@/lib/time";

/** Pengembalian dana talangan dengan bukti transfer; nominal di bukti harus sama dengan nominal yang dikembalikan */
export const repayTalanganAction = action(
  "finance.approve",
  async (fd, user) => {
    const amount = int(fd, "amount");
    const file = fd.get("proof");
    if (!(file && typeof file === "object" && "arrayBuffer" in file && file.size > 0)) throw new Error("Lampirkan foto bukti transfer pengembalian");
    if (!["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(file.type)) throw new Error("Bukti harus JPG, PNG, WEBP, atau PDF");
    const buf = Buffer.from(await file.arrayBuffer());
    if (!fd.get("skipCheck")) {
      const read = await readProofAmount(buf, file.type);
      if (read && read !== amount) throw new Error(`Nominal di bukti terbaca Rp ${read.toLocaleString("id-ID")}, tidak sama dengan Rp ${amount.toLocaleString("id-ID")}. Periksa lagi, atau centang "nominal di bukti sudah benar".`);
    }
    const path = await saveProof(buf, file.type);
    const r = await repayTalangan({ walletId: str(fd, "walletId"), amount, date: str(fd, "date") || todayStr(), fromBankId: optStr(fd, "fromBankId"), proofPath: path, proofMime: file.type }, "MANUAL", { id: user.id, name: user.name });
    return r.booked ? `Pengembalian dibukukan (${r.transaction.number})` : `Tercatat ${r.transaction.number}, perlu ditinjau di menu Transaksi (terindikasi duplikat)`;
  },
  ["/finance/talangan", "/finance", "/"],
);

/** Tanggal mulai menghitung talangan */
export const setTalanganStart = action(
  "finance.approve",
  async (fd, user) => {
    const v = str(fd, "start");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error("Tanggal tidak valid");
    await prisma.setting.upsert({ where: { key: "talangan_mulai" }, create: { key: "talangan_mulai", value: v }, update: { value: v } });
    await audit(user, "TALANGAN_MULAI", "Setting", "talangan_mulai", { value: v });
    return "Tanggal mulai disimpan";
  },
  ["/finance/talangan", "/"],
);

/** Transfer yang sudah dibukukan ke dompet simpanan ditandai sebagai pengembalian talangan */
export const markRepayAction = action(
  "finance.approve",
  async (fd, user) => {
    const t = await markTalanganRepay(str(fd, "id"), { id: user.id, name: user.name });
    return `${t.number} ditandai sebagai pengembalian talangan`;
  },
  ["/finance/talangan", "/finance", "/"],
);
