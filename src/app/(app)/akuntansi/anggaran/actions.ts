"use server";
import { action, int, optStr, str } from "@/lib/action";
import { copyBudgetFromPrev, deleteBudget, monthLabel, parseMonth, prevMonth, saveBudget } from "@/lib/budget";

export const saveBudgetAction = action(
  "accounting.post",
  async (fd, user) => {
    const { year, month } = parseMonth(str(fd, "month"));
    await saveBudget({ year, month, accountId: str(fd, "accountId"), amount: int(fd, "amount"), note: optStr(fd, "note") }, user);
    return `Anggaran ${monthLabel(year, month)} tersimpan`;
  },
  ["/akuntansi/anggaran", "/"],
);

export const deleteBudgetAction = action(
  "accounting.post",
  async (fd, user) => {
    await deleteBudget(str(fd, "id"), user);
    return "Anggaran dihapus";
  },
  ["/akuntansi/anggaran", "/"],
);

export const copyBudgetAction = action(
  "accounting.post",
  async (fd, user) => {
    const { year, month } = parseMonth(str(fd, "month"));
    const r = await copyBudgetFromPrev(year, month, user);
    const p = prevMonth(year, month);
    return `${r.copied} anggaran disalin dari ${monthLabel(p.year, p.month)}${r.skipped ? ` (${r.skipped} akun dilewati karena sudah ada)` : ""}`;
  },
  ["/akuntansi/anggaran", "/"],
);
