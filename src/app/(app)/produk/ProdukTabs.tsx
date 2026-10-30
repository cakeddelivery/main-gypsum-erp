import { Tabs } from "@/components/ui";

const TABS = [
  { key: "produk", label: "Produk Jadi", href: "/produk" },
  { key: "bsj", label: "Barang Setengah Jadi", href: "/produk/setengah-jadi" },
  { key: "overhead", label: "Overhead", href: "/produk/overhead" },
  { key: "biaya", label: "Biaya Marketplace", href: "/produk/biaya" },
];

export function ProdukTabs({ current }: { current: string }) {
  return <Tabs current={current} tabs={TABS} />;
}
