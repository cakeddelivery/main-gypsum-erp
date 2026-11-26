import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { claimOrderInvoice, releaseOrderInvoice } from "@/lib/marketplace/invoiceClaim";
describe("Audit Keuangan — invoice dari pesanan marketplace", () => {
  it("klaim paralel: hanya satu yang lolos; setelah dilepas bisa diklaim lagi", async () => {
    const store = await prisma.store.findFirstOrThrow();
    const importId = (await prisma.marketplaceImport.create({ data: { createdBy: "uji", storeId: store.id, channel: "SHP", kind: "ORDER", fileName: "uji.xlsx" } })).id;
    const o = await prisma.marketplaceOrder.create({ data: { storeId: store.id, channel: "SHP", orderNo: `UJI-INV-${Date.now()}`, status: "SELESAI", importId, lastImportId: importId } });
    const r = await Promise.allSettled([claimOrderInvoice(o.id), claimOrderInvoice(o.id), claimOrderInvoice(o.id)]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    await releaseOrderInvoice(o.id);
    await expect(claimOrderInvoice(o.id)).resolves.toBeUndefined();
  });
});
