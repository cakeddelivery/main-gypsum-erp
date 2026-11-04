"use server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { action, str, optStr, int } from "@/lib/action";
import { audit } from "@/lib/audit";
import { attachReserveProof, postAllReserves, postReserve, withdrawReserve, type Proof } from "@/lib/reserve";
import { saveProof } from "@/lib/storage";
import { defaultStoreId } from "@/lib/accounting";
import { addDays, todayStr } from "@/lib/time";
import type { ReserveKind } from "@prisma/client";

const PATHS = ["/finance/sisihan", "/"];

/** Foto/PDF bukti transfer dari form (opsional) */
async function proofOf(fd: FormData): Promise<Proof> {
  const file = fd.get("proof");
  if (!(file && typeof file === "object" && "arrayBuffer" in file && file.size > 0)) return null;
  if (!["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(file.type)) throw new Error("Bukti harus JPG, PNG, WEBP, atau PDF");
  return { path: await saveProof(Buffer.from(await file.arrayBuffer()), file.type), mime: file.type };
}

export const reserveAll = action(
  "finance.approve",
  async (fd, user) => {
    // Bisa satu tanggal atau rentang (mengejar hari yang terlewat); tanggal yang sudah disisihkan dilewati
    const to = str(fd, "date") || todayStr();
    const from = optStr(fd, "from") ?? to;
    if (from > to) throw new Error("Tanggal awal harus sebelum tanggal akhir");
    if (addDays(from, 62) < to) throw new Error("Rentang maksimal 2 bulan sekali catat");
    let count = 0;
    let total = 0;
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const r = await postAllReserves(d, user);
      count += r.count;
      total += r.total;
    }
    return count ? `${count} sisihan dicatat, total Rp ${total.toLocaleString("id-ID")}` : "Semua dana sudah disisihkan untuk tanggal tersebut";
  },
  PATHS,
);

export const reserveOne = action(
  "finance.approve",
  async (fd, user) => {
    const amount = int(fd, "amount");
    await postReserve(str(fd, "fundId"), str(fd, "date") || todayStr(), user, amount > 0 ? amount : undefined, await proofOf(fd));
    return "Sisihan dicatat";
  },
  PATHS,
);

export const withdraw = action(
  "finance.approve",
  async (fd, user) => {
    await withdrawReserve(str(fd, "fundId"), int(fd, "amount"), str(fd, "date") || todayStr(), user, optStr(fd, "note"), await proofOf(fd), { payableId: optStr(fd, "payableId"), interest: str(fd, "interest") ? int(fd, "interest") : null });
    return "Penarikan dibukukan";
  },
  PATHS,
);

/** Lampirkan bukti transfer ke sisihan yang sudah tercatat (bisa sekaligus semua dana pada tanggal yang sama) */
export const attachProof = action(
  "finance.approve",
  async (fd, user) => {
    const proof = await proofOf(fd);
    if (!proof) throw new Error("Pilih foto bukti transfer");
    const ids = fd.getAll("entryId").map(String).filter(Boolean);
    if (!ids.length) throw new Error("Pilih sisihan yang dilampiri bukti");
    const n = await attachReserveProof(ids, proof, user);
    return `Bukti dilampirkan ke ${n} sisihan`;
  },
  PATHS,
);

export const saveFund = action(
  "finance.approve",
  async (fd, user) => {
    const id = optStr(fd, "id");
    const kind = z.enum(["OWNER", "LOAN_SAVING", "LOAN_PAYMENT"]).parse(str(fd, "kind")) as ReserveKind;
    const data = {
      name: z.string().min(3, "Nama dana wajib").parse(str(fd, "name")),
      kind,
      dailyAmount: BigInt(int(fd, "dailyAmount")),
      fromBankId: z.string().min(1, "Rekening asal wajib").parse(str(fd, "fromBankId")),
      toBankId: kind === "LOAN_PAYMENT" ? null : z.string().min(1, "Rekening tujuan wajib").parse(str(fd, "toBankId")),
      payableId: kind === "OWNER" ? null : optStr(fd, "payableId"),
      storeId: optStr(fd, "storeId") ?? (id ? (await prisma.reserveFund.findUniqueOrThrow({ where: { id } })).storeId : await defaultStoreId()),
      active: fd.get("active") !== "off",
    };
    if (data.dailyAmount <= BigInt(0)) throw new Error("Nominal harian harus > 0");
    // Cicilan harian langsung mengurangi hutang, jadi wajib terhubung ke pinjaman. Tabungan cicilan boleh
    // dikumpulkan dulu; pinjamannya cukup dipilih sebelum tabungan dibayarkan.
    if (kind === "LOAN_PAYMENT" && !data.payableId) throw new Error("Pilih pinjaman modal yang dicicil (catat dulu di Akuntansi › Piutang, hutang & pinjaman)");
    if (data.toBankId && data.toBankId === data.fromBankId) throw new Error("Rekening asal dan tujuan harus berbeda");
    const f = id ? await prisma.reserveFund.update({ where: { id }, data }) : await prisma.reserveFund.create({ data });
    await audit(user, id ? "DANA_SISIHAN_DIUBAH" : "DANA_SISIHAN_DIBUAT", "ReserveFund", f.id, { ...data, dailyAmount: Number(data.dailyAmount) });
    return "Dana sisihan tersimpan";
  },
  PATHS,
);
