"use server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { action, str, optStr, int, dec, bool } from "@/lib/action";
import { recordMovement } from "@/lib/stock";
import { audit } from "@/lib/audit";
import { saveItemRecord } from "@/lib/items";
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
    // "18.000" ditulis dengan titik ribuan → 18000; "0,5" → 0.5
    const raw = str(fd, "hppFactor");
    const hppFactor = raw ? (/^\d{1,3}(\.\d{3})+$/.test(raw) ? Number(raw.replace(/\./g, "")) : dec(fd, "hppFactor", 1)) : 1;
    const it = await saveItemRecord(
      {
        id,
        sku: optStr(fd, "sku"),
        name: str(fd, "name"),
        type: z.enum(["BAHAN_BAKU", "BARANG_DALAM_PROSES", "BARANG_JADI"]).parse(str(fd, "type")) as ItemType,
        category: optStr(fd, "category"),
        unit: str(fd, "unit"),
        hppUnit: optStr(fd, "hppUnit"),
        hppFactor,
        minStock: dec(fd, "minStock"),
        supplierId: optStr(fd, "supplierId"),
        newSupplierName: optStr(fd, "newSupplierName"),
        gypsumCharacterId: optStr(fd, "gypsumCharacterId"),
        divisionId: optStr(fd, "divisionId"),
        note: optStr(fd, "note"),
        active: id ? bool(fd, "active") : true,
        price: id ? undefined : int(fd, "price"),
        openingQty: id ? undefined : dec(fd, "openingQty"),
      },
      user,
    );
    return `Item ${it.sku} tersimpan`;
  },
  ["/stok", "/supplier"],
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
