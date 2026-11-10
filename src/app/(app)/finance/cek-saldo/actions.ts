"use server";
import { prisma } from "@/lib/db";
import { action } from "@/lib/action";
import { RECIPIENT_SETTING } from "@/lib/balanceCheck";

/** Penerima cek saldo pagi (username, dipisah koma). Kosong = bawaan: Jojo. Owner selalu ikut menerima */
export const setRecipients = action("settings.manage", async (fd) => {
  const ids = fd.getAll("userId").map(String).filter(Boolean);
  const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { username: true } }) : [];
  const value = users.map((u) => u.username).join(",");
  if (value) await prisma.setting.upsert({ where: { key: RECIPIENT_SETTING }, create: { key: RECIPIENT_SETTING, value }, update: { value } });
  else await prisma.setting.deleteMany({ where: { key: RECIPIENT_SETTING } });
  return value ? `Penerima cek saldo: ${value}` : "Penerima cek saldo kembali ke bawaan";
}, ["/finance/cek-saldo"]);
