"use server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { action, str, optStr, int, dec, bool } from "@/lib/action";
import { audit } from "@/lib/audit";
import { productCosting } from "@/lib/hpp";
import type { ProductType, ProductVariant } from "@prisma/client";

const PACK: Record<string, number> = { SATUAN: 1, PAKET_12: 12, PAKET_24: 24, PAKET_48: 48, GIFTBOX: 1, CUSTOM: 1 };

export const saveProduct = action(
  "product.manage",
  async (fd, user) => {
    const id = optStr(fd, "id");
    const type = str(fd, "type") as ProductType;
    const data = {
      sku: z.string().min(2, "SKU wajib").parse(str(fd, "sku").toUpperCase()),
      name: z.string().min(2, "Nama wajib").parse(str(fd, "name")),
      type,
      variant: str(fd, "variant") as ProductVariant,
      storeId: str(fd, "storeId"),
      packQty: int(fd, "packQty", PACK[type] ?? 1) || 1,
      laborCost: BigInt(int(fd, "laborCost")),
      overheadCost: BigInt(int(fd, "overheadCost")),
      finishedItemId: optStr(fd, "finishedItemId"),
      active: id ? bool(fd, "active") : true,
    };
    const p = id ? await prisma.product.update({ where: { id }, data }) : await prisma.product.create({ data });
    await audit(user, id ? "PRODUK_DIUBAH" : "PRODUK_DIBUAT", "Product", p.id, data);
    return "Produk tersimpan";
  },
  ["/produk"],
);

export const saveBom = action(
  "product.manage",
  async (fd, user) => {
    const productId = str(fd, "productId");
    const itemId = str(fd, "itemId");
    const qty = dec(fd, "qty");
    if (qty <= 0) {
      await prisma.bomLine.deleteMany({ where: { productId, itemId } });
    } else {
      await prisma.bomLine.upsert({ where: { productId_itemId: { productId, itemId } }, create: { productId, itemId, qty }, update: { qty } });
    }
    await audit(user, "BOM_DIUBAH", "Product", productId, { itemId, qty });
    return qty <= 0 ? "Bahan dihapus dari BOM" : "BOM tersimpan";
  },
  ["/produk"],
);

/** Catat harga jual baru per kanal; HPP saat itu disimpan untuk histori margin */
export const savePrice = action(
  "product.manage",
  async (fd, user) => {
    const productId = str(fd, "productId");
    const price = int(fd, "price");
    if (price <= 0) throw new Error("Harga harus > 0");
    const { hpp } = await productCosting(productId);
    await prisma.priceHistory.create({ data: { productId, channel: str(fd, "channel"), price: BigInt(price), hpp: BigInt(hpp), createdBy: user.name } });
    await audit(user, "HARGA_DIUBAH", "Product", productId, { channel: str(fd, "channel"), price, hpp });
    return "Harga tersimpan";
  },
  ["/produk"],
);
