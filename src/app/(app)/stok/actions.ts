"use server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { autoCode } from "@/lib/codes";
import { action, str, optStr, int, dec, bool } from "@/lib/action";
import { finishedGoodsOpname, recordMovement } from "@/lib/stock";
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


export const decideRequest = action(
  "stock.approve",
  async (fd, user) => {
    const id = str(fd, "id");
    const decision = str(fd, "decision");
    const r = await prisma.stockRequest.findUniqueOrThrow({ where: { id } });
    // Status diubah bersyarat (WHERE status = ...): dua klik bersamaan tidak bisa memproses permintaan dua kali
    if (decision === "tolak" || decision === "setujui") {
      const n = await prisma.stockRequest.updateMany({ where: { id, status: "DIAJUKAN" }, data: { status: decision === "tolak" ? "DITOLAK" : "DISETUJUI", decidedBy: user.name } });
      if (!n.count) throw new Error("Permintaan sudah diproses");
    } else if (decision === "penuhi") {
      if (r.status !== "DISETUJUI") throw new Error("Setujui permintaan terlebih dahulu");
      await prisma.$transaction(async (tx) => {
        const n = await tx.stockRequest.updateMany({ where: { id, status: "DISETUJUI" }, data: { status: "DIPENUHI", decidedBy: user.name } });
        if (!n.count) throw new Error("Permintaan sudah dipenuhi");
        await recordMovement(tx, { type: "TRANSFER", itemId: r.itemId, qty: Number(r.qty), fromLocationId: str(fd, "fromLocationId"), toLocationId: str(fd, "toLocationId"), ref: `REQ:${r.id}`, note: "Pemenuhan permintaan stok" }, user);
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
        divisionId: optStr(fd, "divisionId"),
        note: optStr(fd, "note"),
        active: id ? bool(fd, "active") : true,
        buyMode: fd.has("buyMode") ? (str(fd, "buyMode") === "ONLINE" ? "ONLINE" : "OFFLINE") : undefined,
        productUrl: optStr(fd, "productUrl"),
        orderQty: fd.has("orderQty") ? dec(fd, "orderQty", 0) : undefined,
        // Item baru: harga pembelian + quantity; item lama: hanya Owner yang boleh mengisi harga manual
        buyPrice: id ? undefined : int(fd, "buyPrice"),
        buyQty: id ? undefined : dec(fd, "buyQty", 1),
        manualCost: id && user.role === "OWNER" && fd.has("buyPrice") ? { price: int(fd, "buyPrice"), qty: dec(fd, "buyQty", 1) } : null,
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
    const data = { name: z.string().min(2).parse(str(fd, "name")), divisionId: optStr(fd, "divisionId") };
    const s = id ? await prisma.location.update({ where: { id }, data }) : await prisma.location.create({ data: { ...data, code: await autoCode.location(prisma, data.name) } });
    await audit(user, "LOKASI_DISIMPAN", "Location", s.id, data);
    return "Lokasi tersimpan";
  },
  ["/stok/master"],
);


/** Opname barang jadi akhir bulan: kolom fisik_<idItem>; kosong = tidak dihitung */
export const opnameFinished = action(
  "stock.approve",
  async (fd, user) => {
    const date = str(fd, "date") || todayStr();
    const rows = [...fd.entries()]
      .filter(([k, v]) => k.startsWith("fisik_") && String(v).trim() !== "")
      .map(([k, v]) => ({ itemId: k.slice(6), physical: Number(String(v).replace(/\./g, "").replace(",", ".")) }));
    if (!rows.length) throw new Error("Isi jumlah fisik minimal satu produk");
    if (rows.some((r) => !Number.isFinite(r.physical))) throw new Error("Jumlah fisik harus angka");
    const r = await finishedGoodsOpname(rows, jakartaDateTime(date, "23:00"), user);
    return r.changed ? `Opname tersimpan: ${r.changed} produk disesuaikan, ${r.sold.toLocaleString("id-ID")} pcs terjual → HPP Rp ${r.hpp.toLocaleString("id-ID")}` : "Stok fisik sama dengan sistem, tidak ada penyesuaian";
  },
  ["/stok", "/akuntansi"],
);

/** Stok awal riil: hitung fisik semua gudang (kolom fisik_<id>, harga_<id>) */
export const saveOpening = action(
  "stock.approve",
  async (fd, user) => {
    const { saveOpeningStock } = await import("@/lib/stockOpening");
    const n = (v: FormDataEntryValue | null) => {
      const s = String(v ?? "").trim().replace(/\./g, "").replace(",", ".");
      return s === "" ? null : Number(s);
    };
    const rows = [...fd.keys()].filter((k) => k.startsWith("fisik_")).map((k) => ({ itemId: k.slice(6), physical: n(fd.get(k)), unitCost: n(fd.get(`harga_${k.slice(6)}`)) }))
      .filter((r): r is { itemId: string; physical: number; unitCost: number | null } => r.physical != null);
    if (rows.some((r) => !Number.isFinite(r.physical) || (r.unitCost != null && !Number.isFinite(r.unitCost)))) throw new Error("Ada angka yang tidak valid");
    const date = str(fd, "date") || todayStr();
    const r = await saveOpeningStock(rows, jakartaDateTime(date, str(fd, "time") || "06:00"), user);
    return `Stok awal tersimpan: ${r.changed} barang disesuaikan`;
  },
  ["/stok"],
);
