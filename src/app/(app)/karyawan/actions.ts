"use server";
import { z } from "zod";
import { syncSalaryOverheadsSafe } from "@/lib/salaryOverhead";
import { prisma } from "@/lib/db";
import { action, str, optStr, int } from "@/lib/action";
import { audit } from "@/lib/audit";
import { ForbiddenError, hashPassword } from "@/lib/auth";
import { clearLoginBlocks, passwordChangeData } from "@/lib/loginGuard";
import { dateOnly, dateStr, todayStr } from "@/lib/time";
import { autoCode } from "@/lib/codes";
import type { EmployeeStatus, Role, WageType } from "@prisma/client";

export const saveEmployee = action(
  "employee.manage",
  async (fd, user) => {
    const id = optStr(fd, "id");
    const join = str(fd, "joinDate");
    const data = {
      name: z.string().min(2, "Nama wajib").parse(str(fd, "name")),
      divisionId: z.string().min(1, "Divisi wajib").parse(str(fd, "divisionId")),
      // Jabatan tidak dipakai lagi (cukup divisi + role); kolom lama dibiarkan
      status: str(fd, "status") as EmployeeStatus,
      wageType: str(fd, "wageType") as WageType,
      dailyRate: BigInt(int(fd, "dailyRate")),
      phone: optStr(fd, "phone"),
      joinDate: join ? dateOnly(join) : null,
      monthlySalary: BigInt(int(fd, "monthlySalary")),
      // BPJS Ketenagakerjaan (dibayar perusahaan); nominal kosong = bawaan Pengaturan
      bpjsTk: str(fd, "bpjsTk") === "on",
      bpjsTkAmount: str(fd, "bpjsTkAmount") ? BigInt(int(fd, "bpjsTkAmount")) : null,
    };
    if (data.wageType === "BULANAN" && !data.joinDate) throw new Error("Karyawan bulanan wajib punya tanggal masuk (dasar tanggal gajian)");
    if (data.wageType === "BULANAN" && data.monthlySalary <= BigInt(0)) throw new Error("Isi gaji bulanan");
    // Tunjangan ikut disimpan dari form (hanya pengelola penggajian)
    const allowances = fd.has("allowancesPresent") && user.can("payroll.manage") ? parseAllowances(fd) : null;
    // Kode karyawan otomatis per divisi (CTK-001); kode tetap walau pindah divisi
    const e = await prisma.$transaction(async (tx) => {
      const e = id ? await tx.employee.update({ where: { id }, data }) : await tx.employee.create({ data: { ...data, code: await autoCode.employee(tx, data.divisionId) } });
      if (allowances) {
        const keep = allowances.filter((a) => a.id).map((a) => a.id!);
        await tx.employeeAllowance.deleteMany({ where: { employeeId: e.id, id: { notIn: keep } } });
        for (const a of allowances) {
          if (a.id) await tx.employeeAllowance.updateMany({ where: { id: a.id, employeeId: e.id }, data: { name: a.name, amount: BigInt(a.amount), active: true } });
          else await tx.employeeAllowance.create({ data: { employeeId: e.id, name: a.name, amount: BigInt(a.amount) } });
        }
      }
      return e;
    });
    if (data.status === "NONAKTIF") await prisma.user.updateMany({ where: { employeeId: e.id }, data: { active: false } });
    await audit(user, id ? "KARYAWAN_DIUBAH" : "KARYAWAN_DIBUAT", "Employee", e.id, { ...data, allowances });
    await syncSalaryOverheadsSafe();
    return "Data karyawan tersimpan";
  },
  ["/karyawan", "/gaji/tunjangan"],
);

function parseAllowances(fd: FormData) {
  const ids = fd.getAll("allowId").map(String);
  const names = fd.getAll("allowName").map((v) => String(v).trim());
  const amounts = fd.getAll("allowAmount").map((v) => Number(String(v).replace(/\D/g, "")));
  return names.map((name, i) => {
    if (name.length < 2) throw new Error("Nama tunjangan minimal 2 huruf");
    if (!(amounts[i] > 0)) throw new Error(`Nominal tunjangan ${name} harus lebih dari 0`);
    return { id: ids[i] || null, name, amount: amounts[i] };
  });
}

/** Resign karyawan aktif: isi tanggal resign. Bila tanggalnya sudah lewat/hari ini, status jadi Nonaktif & akun login dimatikan. */
export const resignEmployee = action(
  "employee.manage",
  async (fd, user) => {
    const id = str(fd, "id");
    const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Isi tanggal resign").parse(str(fd, "resignDate"));
    if (str(fd, "confirm") !== "on") throw new Error("Centang konfirmasi resign dulu");
    const e = await prisma.employee.findUniqueOrThrow({ where: { id } });
    if (e.resignDate) throw new Error("Karyawan ini sudah tercatat resign");
    if (e.joinDate && date < dateStr(e.joinDate)) throw new Error("Tanggal resign tidak boleh sebelum tanggal masuk");
    const now = date <= todayStr();
    await prisma.$transaction(async (tx) => {
      await tx.employee.update({ where: { id }, data: { resignDate: dateOnly(date), ...(now ? { status: "NONAKTIF" as const } : {}) } });
      if (now) await tx.user.updateMany({ where: { employeeId: id }, data: { active: false } });
    });
    await audit(user, "KARYAWAN_RESIGN", "Employee", id, { resignDate: date, nonaktif: now });
    await syncSalaryOverheadsSafe();
    return now ? `${e.name} resign per ${date}. Status Nonaktif, akun login dimatikan.` : `${e.name} dijadwalkan resign ${date}.`;
  },
  ["/karyawan"],
);

/** Batalkan resign (salah input): tanggal resign dihapus, status kembali Aktif. Akun login diaktifkan lagi lewat tombol Akun. */
export const cancelResign = action(
  "employee.manage",
  async (fd, user) => {
    const id = str(fd, "id");
    const e = await prisma.employee.update({ where: { id }, data: { resignDate: null, status: "AKTIF" } });
    await audit(user, "KARYAWAN_RESIGN_DIBATALKAN", "Employee", id, null);
    await syncSalaryOverheadsSafe();
    return `Resign ${e.name} dibatalkan`;
  },
  ["/karyawan"],
);

const FIELD_ROLES: Role[] = ["OPERATOR", "KAPTEN_DIVISI", "PIC_CONTENT", "ADMIN_PRODUKSI", "ADMIN_MARKETPLACE"];

/** Buat / perbarui akun login karyawan */
export const saveAccount = action(
  "employee.manage",
  async (fd, user) => {
    const employeeId = str(fd, "employeeId");
    const role = str(fd, "role") as Role;
    // Selain Owner/pengelola pengguna, hanya boleh memberi role lapangan
    if (!user.can("users.manage") && !FIELD_ROLES.includes(role)) throw new ForbiddenError();
    if (role === "OWNER" && user.role !== "OWNER") throw new ForbiddenError();
    const emp = await prisma.employee.findUniqueOrThrow({ where: { id: employeeId } });
    const existing = await prisma.user.findUnique({ where: { employeeId } });
    // Akun yang sudah ber-role di atas role lapangan (Finance/Admin/Owner…) hanya boleh diubah pengelola pengguna;
    // tanpa ini Admin bisa mengganti password akun Finance/Owner yang tertaut ke data karyawan
    if (existing && !user.can("users.manage") && !FIELD_ROLES.includes(existing.role)) throw new ForbiddenError();
    if (existing?.role === "OWNER" && user.role !== "OWNER") throw new ForbiddenError();
    const password = str(fd, "password");
    const username = z.string().regex(/^[a-z0-9._-]{3,30}$/, "Username 3-30 huruf kecil/angka").parse(str(fd, "username").toLowerCase());
    if (existing) {
      await prisma.user.update({ where: { id: existing.id }, data: { username, role, divisionId: role === "KAPTEN_DIVISI" ? emp.divisionId : null, active: str(fd, "active") !== "off", ...(password ? passwordChangeData(await hashPassword(password)) : {}) } });
      if (password) await clearLoginBlocks(username);
    } else {
      if (!password) throw new Error("Password wajib untuk akun baru");
      await prisma.user.create({ data: { username, name: emp.name, role, employeeId, divisionId: role === "KAPTEN_DIVISI" ? emp.divisionId : null, passwordHash: await hashPassword(password) } });
    }
    await audit(user, existing ? "AKUN_DIUBAH" : "AKUN_DIBUAT", "User", employeeId, { username, role });
    return "Akun login tersimpan";
  },
  ["/karyawan"],
);
