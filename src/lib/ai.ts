import "server-only";
import Anthropic from "@anthropic-ai/sdk";

/**
 * Akses model AI. Dua pilihan, diatur lewat .env:
 * - ANTHROPIC_API_KEY: langsung ke Claude API (Anthropic SDK).
 * - AI_BASE_URL + AI_API_KEY: provider OpenAI-compatible (mis. reseller lokal) lewat /chat/completions.
 * Bila keduanya diisi, AI_BASE_URL yang dipakai.
 */
type Provider = "openai" | "anthropic" | null;

function provider(): Provider {
  if (process.env.AI_BASE_URL && process.env.AI_API_KEY) return "openai";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  return null;
}

export function aiConfigured() {
  return provider() !== null;
}

/** Model per fitur: ADVISOR_MODEL / RECEIPT_MODEL, lalu AI_MODEL, lalu default per provider */
export function modelFor(envName: "ADVISOR_MODEL" | "RECEIPT_MODEL") {
  // Reseller OpenAI-compatible umumnya memakai titik pada versi (claude-haiku-5.5)
  const fallback = provider() === "openai" ? "claude-haiku-5.5" : "claude-opus-5-5";
  return process.env[envName] || process.env.AI_MODEL || fallback;
}

export type AiImage = { data: Buffer; mime: string };

/** Kirim satu pesan (teks + gambar opsional) dan kembalikan teks jawaban */
export async function aiText(opts: { model: string; system?: string; text: string; image?: AiImage; maxTokens: number; effort?: "low" | "medium" }): Promise<string> {
  const p = provider();
  if (!p) throw new Error("AI belum diatur: isi ANTHROPIC_API_KEY atau AI_BASE_URL + AI_API_KEY di .env");
  if (p === "openai") {
    const content: unknown[] = [];
    if (opts.image) content.push({ type: "image_url", image_url: { url: `data:${opts.image.mime};base64,${opts.image.data.toString("base64")}` } });
    content.push({ type: "text", text: opts.text });
    const messages = [...(opts.system ? [{ role: "system", content: opts.system }] : []), { role: "user", content: opts.image ? content : opts.text }];
    const res = await fetch(`${process.env.AI_BASE_URL!.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.AI_API_KEY}` },
      body: JSON.stringify({ model: opts.model, max_tokens: opts.maxTokens, messages }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) throw new Error(`Provider AI HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { choices?: { message?: { content?: string | { type: string; text?: string }[] }; finish_reason?: string }[] };
    const c = json.choices?.[0]?.message?.content;
    const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => x.text ?? "").join("") : "";
    return text.trim();
  }
  const client = new Anthropic();
  const response = await client.messages.create({
    model: opts.model,
    max_tokens: opts.maxTokens,
    output_config: { effort: opts.effort ?? "medium" },
    ...(opts.system ? { system: opts.system } : {}),
    messages: [
      {
        role: "user",
        content: [
          ...(opts.image ? [{ type: "image" as const, source: { type: "base64" as const, media_type: opts.image.mime as "image/jpeg", data: opts.image.data.toString("base64") } }] : []),
          { type: "text" as const, text: opts.text },
        ],
      },
    ],
  });
  if (response.stop_reason === "refusal") throw new Error("Permintaan tidak dapat diproses oleh AI");
  return response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
}

/** Ambil objek JSON pertama dari jawaban model (toleran terhadap ```json ... ``` atau teks pembuka) */
export function parseJsonObject<T>(text: string): T | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
