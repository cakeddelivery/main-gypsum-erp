"use client";
import { useEffect } from "react";

/** Beri label kolom (data-label) pada tiap sel tabel .tbl, dipakai CSS untuk tampilan kartu di HP */
function labelTables(root: ParentNode) {
  root.querySelectorAll<HTMLTableElement>("table.tbl").forEach((t) => {
    const heads = [...t.querySelectorAll<HTMLTableCellElement>("thead th")].flatMap((th) => Array<string>(th.colSpan).fill(th.textContent?.trim() ?? ""));
    t.querySelectorAll<HTMLTableRowElement>(":scope > tbody > tr, :scope > tfoot > tr").forEach((tr) => {
      let col = 0;
      for (const td of [...tr.cells]) {
        if (!td.hasAttribute("data-label")) td.setAttribute("data-label", td.colSpan > 1 ? "" : heads[col] ?? "");
        col += td.colSpan;
      }
    });
  });
}

export function ResponsiveTables() {
  useEffect(() => {
    const main = document.querySelector("main");
    if (!main) return;
    labelTables(main);
    const obs = new MutationObserver(() => labelTables(main));
    obs.observe(main, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, []);
  return null;
}
