import JSZip from "jszip";

/** Pembaca .xlsx ringan (murni, tanpa pustaka besar). Mengabaikan atribut "dimension" yang sering salah di file marketplace. */
export type Cell = string | number | null;
export type Sheet = { name: string; rows: Cell[][] };

const unesc = (s: string) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** Teks dari semua <t> dalam potongan XML (rich text digabung) */
const textOf = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unesc(m[1])).join("");

const colIndex = (ref: string) => {
  let n = 0;
  for (const ch of ref.replace(/[^A-Z]/gi, "").toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
};

export class XlsxError extends Error {}

export async function readXlsx(buf: Buffer | ArrayBuffer | Uint8Array): Promise<Sheet[]> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch {
    throw new XlsxError("File ini bukan Excel (.xlsx) yang valid");
  }
  const wb = await zip.file("xl/workbook.xml")?.async("string");
  if (!wb) throw new XlsxError("File ini bukan Excel (.xlsx) yang valid");
  const rels = (await zip.file("xl/_rels/workbook.xml.rels")?.async("string")) ?? "";
  const relTarget = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b([^>]*)>/g)) {
    const id = /\bId="([^"]*)"/.exec(m[1])?.[1];
    const target = /\bTarget="([^"]*)"/.exec(m[1])?.[1];
    if (id && target) relTarget.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`);
  }
  const ssXml = await zip.file("xl/sharedStrings.xml")?.async("string");
  const shared = ssXml ? [...ssXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1])) : [];

  const out: Sheet[] = [];
  const sheetTags = [...wb.matchAll(/<sheet\b([^>]*)\/?>/g)];
  let i = 0;
  for (const m of sheetTags) {
    i++;
    const name = unesc(/\bname="([^"]*)"/.exec(m[1])?.[1] ?? `Sheet${i}`);
    const rid = /\br:id="([^"]*)"/.exec(m[1])?.[1];
    const path = (rid && relTarget.get(rid)) || `xl/worksheets/sheet${i}.xml`;
    const xml = await zip.file(path)?.async("string");
    if (!xml) continue;
    const rows: Cell[][] = [];
    for (const r of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const rowNo = Number(/\br="(\d+)"/.exec(r[1])?.[1] ?? rows.length + 1);
      const cells: Cell[] = [];
      for (const c of (r[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1];
        const ref = /\br="([A-Z]+\d*)"/.exec(attrs)?.[1];
        const idx = ref ? colIndex(ref) : cells.length;
        const t = /\bt="([^"]*)"/.exec(attrs)?.[1];
        const body = c[2] ?? "";
        let v: Cell = null;
        if (t === "inlineStr") v = textOf(body);
        else {
          const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
          if (raw !== undefined) {
            if (t === "s") v = shared[Number(raw)] ?? "";
            else if (t === "str" || t === "e") v = unesc(raw);
            else if (t === "b") v = raw === "1" ? 1 : 0;
            else v = Number(raw);
          }
        }
        cells[idx] = v;
      }
      rows[rowNo - 1] = Array.from(cells, (x) => x ?? null);
    }
    out.push({ name, rows: Array.from(rows, (x) => x ?? []) });
  }
  return out;
}
