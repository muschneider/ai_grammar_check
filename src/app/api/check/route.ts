import { NextRequest } from "next/server";

// Edge runtime: na Vercel, é o único que suporta streaming de verdade com
// ReadableStream. Tempo limite maior no Hobby (~25s) e melhor para respostas
// streaming de LLMs.
export const runtime = "edge";
export const dynamic = "force-dynamic";

const MODEL = process.env.OPENROUTER_MODEL ?? "google/gemini-2.5-flash-lite";
const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

const SYSTEM_PROMPT = [
  "Você é um revisor de textos profissional.",
  "Corrija gramática, ortografia, pontuação e fluência do texto fornecido.",
  "Regras estritas:",
  "- Devolva APENAS o texto corrigido, sem comentários, explicações, marcadores ou aspas adicionais.",
  "- Mantenha o sentido original do conteúdo; não reescreva fatos.",
  "- Preserve quebras de linha e a estrutura de parágrafos do texto original.",
  "- Se o texto já estiver correto, retorne-o igual.",
].join(" ");

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response("JSON inválido", { status: 400 });
  }

  const { text, language, style } = (body ?? {}) as {
    text?: string;
    language?: string;
    style?: string;
  };

  if (typeof text !== "string" || !text.trim()) {
    return new Response("Texto vazio", { status: 400 });
  }
  if (typeof language !== "string" || !language.trim()) {
    return new Response("Idioma ausente", { status: 400 });
  }
  if (typeof style !== "string" || !style.trim()) {
    return new Response("Estilo ausente", { status: 400 });
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return new Response(
      "OPENROUTER_API_KEY não configurada no servidor (.env.local).",
      { status: 500 },
    );
  }

  const system = `${SYSTEM_PROMPT} Idioma de escrita esperado: ${language}. Tom/estilo desejado: ${style}.`;
  const user = `Corrija o texto a seguir (idioma: ${language}; estilo: ${style}):\n\n${text}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "X-Title": "AI Grammar Check",
  };
  const referer = req.headers.get("origin");
  if (referer) headers["HTTP-Referer"] = referer;

  let upstream: Response;
  try {
    upstream = await fetch(ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: MODEL,
        stream: true,
        temperature: 0.2,
        max_tokens: Math.max(128, Math.min(4096, text.length * 6)),
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
  } catch (err) {
    const msg =
      err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return new Response(
      `Falha ao contatar o OpenRouter: ${msg}`,
      { status: 502 },
    );
  }

  if (!upstream.ok || !upstream.body) {
    const errText = await upstream.text().catch(() => "");
    return new Response(
      `OpenRouter retornou ${upstream.status}: ${errText.slice(0, 500)}`,
      { status: 502 },
    );
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.body!.getReader();
      let buffer = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data:")) continue;
            const data = trimmed.slice(5).trim();
            if (data === "[DONE]") {
              controller.close();
              return;
            }
            try {
              const json = JSON.parse(data);
              const delta: string | undefined = json?.choices?.[0]?.delta?.content;
              if (delta) controller.enqueue(encoder.encode(delta));
            } catch {
              /* ignora chunk inválido */
            }
          }
        }
      } catch (err) {
        controller.error(err);
        return;
      }
      controller.close();
    },
    cancel() {
      upstream.body?.cancel().catch(() => {});
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}