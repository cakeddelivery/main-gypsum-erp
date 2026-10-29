"use server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { action, str, optStr, int } from "@/lib/action";
import { audit } from "@/lib/audit";
import { ForbiddenError, hashPassword } from "@/lib/auth";
import { dateOnly } from "@/lib/time";
import type { EmployeeStatus, Role, WageType } from "@prisma/client";

export const saveEmployee = action(
  "employee.manage",
  async (fd, user) => {
    const id = optStr(fd, "id");
    const join = str(fd, "joinDate");
    const resign = str(fd, "resignDate");
    const data = {
      code: z.string().min(2, "Kode wajib").parse(str(fd, "code").toUpperCase()),
      name: z.string().min(2, "Nama wajib").parse(str(fd, "name")),
      divisionId: z.string().min(1, "Divisi wajib").parse(str(fd, "divisionId")),
      position: z.string().min(2, "Jabatan wajib").parse(str(fd, "position")),
      status: str(fd, "status") as EmployeeStatus,
      wageType: str(fd, "wageType") as WageType,
      dailyRate: BigInt(int(fd, "dailyRate")),
      phone: optStr(fd, "phone"),
      joinDate: join ? dateOnly(join) : null,
      monthlySalary: BigInt(int(fd, "monthlySalary")),
      resignDate: resign ? dateOnly(resign) : null,
    };
    if (data.wageType === "BULANAN" && !data.joinDate) throw new Error("Karyawan bulanan wajib punya tanggal masuk (dasar tanggal gajian)");
    if (data.wageType === "BULANAN" && data.monthlySalary <= BigInt(0)) throw new Error("Isi gaji bulanan");
    if (resign && join && resign < join) throw new Error("Tanggal resign tidak boleh sebelum tanggal masuk");
    const e = id ? await prisma.employee.update({ where: { id }, data }) : await prisma.employee.create({ data });
    if (data.status === "NONAKTIF") await prisma.user.updateMany({ where: { employeeId: e.id }, data: { active: false } });
    await audit(user, id ? "KARYAWAN_DIUBAH" : "KARYAWAN_DIBUAT", "Employee", e.id, data);
    return "Data karyawan tersimpan";
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
    const password = str(fd, "password");
    const username = z.string().regex(/^[a-z0-9._-]{3,30}$/, "Username 3-30 huruf kecil/angka").parse(str(fd, "username").toLowerCase());
    if (existing) {
      await prisma.user.update({ where: { id: existing.id }, data: { username, role, divisionId: role === "KAPTEN_DIVISI" ? emp.divisionId : null, active: str(fd, "active") !== "off", ...(password ? { passwordHash: await hashPassword(password), failedLogins: 0, lockedUntil: null } : {}) } });
    } else {
      if (!password) throw new Error("Password wajib untuk akun baru");
      await prisma.user.create({ data: { username, name: emp.name, role, employeeId, divisionId: role === "KAPTEN_DIVISI" ? emp.divisionId : null, passwordHash: await hashPassword(password) } });
    }
    await audit(user, existing ? "AKUN_DIUBAH" : "AKUN_DIBUAT", "User", employeeId, { username, role });
    return "Akun login tersimpan";
  },
  ["/karyawan"],
);
