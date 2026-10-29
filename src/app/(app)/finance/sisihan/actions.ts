"use server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { action, str, optStr, int } from "@/lib/action";
import { audit } from "@/lib/audit";
import { postAllReserves, postReserve, withdrawReserve } from "@/lib/reserve";
import { todayStr } from "@/lib/time";
import type { ReserveKind } from "@prisma/client";

const PATHS = ["/finance/sisihan", "/"];

export const reserveAll = action(
  "finance.approve",
  async (fd, user) => {
    const r = await postAllReserves(str(fd, "date") || todayStr(), user);
    return r.count ? `${r.count} sisihan dicatat, total Rp ${r.total.toLocaleString("id-ID")}` : "Semua dana sudah disisihkan untuk tanggal ini";
  },
  PATHS,
);

export const reserveOne = action(
  "finance.approve",
  async (fd, user) => {
    const amount = int(fd, "amount");
    await postReserve(str(fd, "fundId"), str(fd, "date") || todayStr(), user, amount > 0 ? amount : undefined);
    return "Sisihan dicatat";
  },
  PATHS,
);

export const withdraw = action(
  "finance.approve",
  async (fd, user) => {
    await withdrawReserve(str(fd, "fundId"), int(fd, "amount"), str(fd, "date") || todayStr(), user, optStr(fd, "note"));
    return "Penarikan dibukukan";
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
      storeId: str(fd, "storeId"),
      active: fd.get("active") !== "off",
    };
    if (data.dailyAmount <= BigInt(0)) throw new Error("Nominal harian harus > 0");
    if (kind !== "OWNER" && !data.payableId) throw new Error("Pilih pinjaman modal yang dicicil");
    if (data.toBankId && data.toBankId === data.fromBankId) throw new Error("Rekening asal dan tujuan harus berbeda");
    const f = id ? await prisma.reserveFund.update({ where: { id }, data }) : await prisma.reserveFund.create({ data });
    await audit(user, id ? "DANA_SISIHAN_DIUBAH" : "DANA_SISIHAN_DIBUAT", "ReserveFund", f.id, { ...data, dailyAmount: Number(data.dailyAmount) });
    return "Dana sisihan tersimpan";
  },
  PATHS,
);
