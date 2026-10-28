"use server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { action, str, optStr, int, dec, bool } from "@/lib/action";
import { recordMovement } from "@/lib/stock";
import { audit } from "@/lib/audit";
import { ForbiddenError } from "@/lib/auth";
import { jakartaDateTime, todayStr } from "@/lib/time";
import type { ItemType, MovementType } from "@prisma/client";

const TYPES = ["PENERIMAAN", "PENGELUARAN", "TRANSFER", "PENYESUAIAN"] as const;

export const createMovement = action(
  "stock.move",
  async (fd, user) => {
    const type = z.enum(TYPES).parse(str(fd, "type")) as MovementType;
    if (type === "PENYESUAIAN" && !user.can("stock.approve")) throw new ForbiddenError();
    const date = str(fd, "date") || todayStr();
    await prisma.$transaction((tx) =>
      recordMovement(
        tx,
        {
          type,
          itemId: str(fd, "itemId"),
          qty: dec(fd, "qty"),
          fromLocationId: optStr(fd, "fromLocationId"),
          toLocationId: optStr(fd, "toLocationId"),
          unitCost: type === "PENERIMAAN" ? int(fd, "unitCost") : undefined,
          increase: str(fd, "direction") === "plus",
          ref: optStr(fd, "ref"),
          note: optStr(fd, "note"),
          date: jakartaDateTime(date, "12:00"),
        },
        user,
      ),
    );
    return "Mutasi stok tercatat";
  },
  ["/stok"],
);

export const createRequest = action(
  "stock.request",
  async (fd, user) => {
    const divisionId = str(fd, "divisionId") || user.divisionId;
    if (!divisionId) throw new Error("Pilih divisi");
    const qty = dec(fd, "qty");
    if (!(qty > 0)) throw new Error("Jumlah harus > 0");
    const r = await prisma.stockRequest.create({ data: { itemId: str(fd, "itemId"), divisionId, qty, note: optStr(fd, "note"), requestedBy: user.name } });
    await audit(user, "PERMINTAAN_STOK", "StockRequest", r.id);
    return "Permintaan stok diajukan";
  },
  ["/stok/permintaan", "/"],
);

export const decideRequest = action(
  "stock.approve",
  async (fd, user) => {
    const id = str(fd, "id");
    const decision = str(fd, "decision");
    const r = await prisma.stockRequest.findUniqueOrThrow({ where: { id } });
    if (decision === "tolak") {
      if (r.status !== "DIAJUKAN") throw new Error("Permintaan sudah diproses");
      await prisma.stockRequest.update({ where: { id }, data: { status: "DITOLAK", decidedBy: user.name } });
    } else if (decision === "setujui") {
      if (r.status !== "DIAJUKAN") throw new Error("Permintaan sudah diproses");
      await prisma.stockRequest.update({ where: { id }, data: { status: "DISETUJUI", decidedBy: user.name } });
    } else if (decision === "penuhi") {
      if (r.status !== "DISETUJUI") throw new Error("Setujui permintaan terlebih dahulu");
      await prisma.$transaction(async (tx) => {
        await recordMovement(tx, { type: "TRANSFER", itemId: r.itemId, qty: Number(r.qty), fromLocationId: str(fd, "fromLocationId"), toLocationId: str(fd, "toLocationId"), ref: `REQ:${r.id}`, note: "Pemenuhan permintaan stok" }, user);
        await tx.stockRequest.update({ where: { id }, data: { status: "DIPENUHI", decidedBy: user.name } });
      });
    }
    await audit(user, `PERMINTAAN_${decision.toUpperCase()}`, "StockRequest", id);
    return "Permintaan diperbarui";
  },
  ["/stok/permintaan", "/"],
);

export const saveItem = action(
  "master.manage",
  async (fd, user) => {
    const id = optStr(fd, "id");
    const data = {
      sku: z.string().min(2, "SKU wajib").parse(str(fd, "sku").toUpperCase()),
      name: z.string().min(2, "Nama wajib").parse(str(fd, "name")),
      type: str(fd, "type") as ItemType,
      unit: str(fd, "unit") || "pcs",
      minStock: dec(fd, "minStock"),
      supplierId: optStr(fd, "supplierId"),
      gypsumCharacterId: optStr(fd, "gypsumCharacterId"),
      active: id ? bool(fd, "active") : true,
      ...(id ? {} : { avgCost: BigInt(int(fd, "avgCost")) }),
    };
    const it = id ? await prisma.item.update({ where: { id }, data }) : await prisma.item.create({ data });
    await audit(user, id ? "ITEM_DIUBAH" : "ITEM_DIBUAT", "Item", it.id, data);
    return "Item tersimpan";
  },
  ["/stok"],
);

export const saveSupplier = action(
  "master.manage",
  async (fd, user) => {
    const id = optStr(fd, "id");
    const data = { name: z.string().min(2).parse(str(fd, "name")), phone: optStr(fd, "phone"), address: optStr(fd, "address") };
    const s = id ? await prisma.supplier.update({ where: { id }, data }) : await prisma.supplier.create({ data });
    await audit(user, "SUPPLIER_DISIMPAN", "Supplier", s.id, data);
    return "Supplier tersimpan";
  },
  ["/stok/master"],
);

export const saveLocation = action(
  "master.manage",
  async (fd, user) => {
    const id = optStr(fd, "id");
    const data = { code: z.string().min(2).parse(str(fd, "code").toUpperCase()), name: z.string().min(2).parse(str(fd, "name")), divisionId: optStr(fd, "divisionId") };
    const s = id ? await prisma.location.update({ where: { id }, data }) : await prisma.location.create({ data });
    await audit(user, "LOKASI_DISIMPAN", "Location", s.id, data);
    return "Lokasi tersimpan";
  },
  ["/stok/master"],
);

export const saveGypsum = action(
  "master.manage",
  async (fd, user) => {
    const id = optStr(fd, "id");
    const minutes = str(fd, "settingMinutes");
    const data = { name: z.string().min(2).parse(str(fd, "name")), waterRatio: optStr(fd, "waterRatio"), settingMinutes: minutes ? int(fd, "settingMinutes") : null, hardness: optStr(fd, "hardness"), note: optStr(fd, "note") };
    const s = id ? await prisma.gypsumCharacter.update({ where: { id }, data }) : await prisma.gypsumCharacter.create({ data });
    await audit(user, "KARAKTER_GYPSUM_DISIMPAN", "GypsumCharacter", s.id, data);
    return "Karakter gypsum tersimpan";
  },
  ["/stok/master"],
);
