"use server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { action, bool, optStr, str } from "@/lib/action";
import { audit } from "@/lib/audit";
import { autoCode } from "@/lib/codes";
import { findSupplierByName, mergeSuppliers } from "@/lib/suppliers";

const data = (fd: FormData) => ({
  name: z.string().min(2, "Nama minimal 2 huruf").parse(str(fd, "name")),
  phone: optStr(fd, "phone"),
  address: optStr(fd, "address"),
  note: optStr(fd, "note"),
  active: fd.has("active") ? bool(fd, "active") : true,
});

export const saveSupplier = action(
  "partner.manage",
  async (fd, user) => {
    const id = optStr(fd, "id");
    const d = { ...data(fd), aliases: (optStr(fd, "aliases") ?? "").split(",").map((x) => x.trim()).filter(Boolean).join(", ").slice(0, 500) };
    // Cegah supplier dobel: nama (atau nama lain) yang sama dengan supplier lain ditolak, sarankan Gabungkan
    for (const n of [d.name, ...d.aliases.split(",")].map((x) => x.trim()).filter(Boolean)) {
      const same = await findSupplierByName(prisma, n);
      if (same && same.id !== id) throw new Error(`"${n}" sudah dipakai supplier ${same.name}. Pakai supplier itu, atau Gabungkan bila sama.`);
    }
    const s = id ? await prisma.supplier.update({ where: { id }, data: d }) : await prisma.supplier.create({ data: { ...d, code: await autoCode.supplier(prisma) } });
    await audit(user, "SUPPLIER_DISIMPAN", "Supplier", s.id, d);
    return "Supplier tersimpan";
  },
  ["/supplier", "/stok/master", "/stok/pembelian"],
);

/** Gabungkan supplier dobel ke supplier lain (hutang, pembelian & item ikut pindah; nama lama jadi nama lain) */
export const mergeSupplier = action(
  "partner.manage",
  async (fd, user) => {
    const r = await mergeSuppliers(str(fd, "sourceId"), str(fd, "targetId"), user, { name: optStr(fd, "name") });
    return `Digabung ke ${r.supplier.name}: ${r.payables} hutang, ${r.purchases} pembelian, ${r.items} item dipindah`;
  },
  ["/supplier", "/stok/master", "/stok/pembelian", "/akuntansi/piutang-utang"],
);

export const deleteSupplier = action(
  "partner.manage",
  async (fd, user) => {
    const id = str(fd, "id");
    const s = await prisma.supplier.findUniqueOrThrow({ where: { id }, include: { _count: { select: { items: true, purchases: true, payables: true } } } });
    if (s._count.items + s._count.purchases + s._count.payables > 0) throw new Error("Supplier sudah dipakai di item/pembelian/utang. Nonaktifkan saja lewat Ubah.");
    await prisma.supplier.delete({ where: { id } });
    await audit(user, "SUPPLIER_DIHAPUS", "Supplier", id, { name: s.name });
    return "Supplier dihapus";
  },
  ["/supplier", "/stok/master"],
);

export const saveCustomer = action(
  "partner.manage",
  async (fd, user) => {
    const id = optStr(fd, "id");
    const d = data(fd);
    const c = id ? await prisma.customer.update({ where: { id }, data: d }) : await prisma.customer.create({ data: { ...d, code: await autoCode.customer(prisma) } });
    await audit(user, "PELANGGAN_DISIMPAN", "Customer", c.id, d);
    return "Pelanggan tersimpan";
  },
  ["/pelanggan"],
);

export const deleteCustomer = action(
  "partner.manage",
  async (fd, user) => {
    const id = str(fd, "id");
    const c = await prisma.customer.delete({ where: { id } });
    await audit(user, "PELANGGAN_DIHAPUS", "Customer", id, { name: c.name });
    return "Pelanggan dihapus";
  },
  ["/pelanggan"],
);
