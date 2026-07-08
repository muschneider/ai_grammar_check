import { NextRequest } from "next/server";

// Edge runtime: na Vercel, é o único que suporta streaming de verdade com
// ReadableStream. Tempo limite maior no Hobby (~25s) e melhor para respostas
// streaming de LLMs.
export const runtime = "edge";
export const dynamic = "force-dynamic";

const MODEL = process.env.OPENROUTER_MODEL ?? "google/gemini-2.5-flash-lite";
const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

const SYSTEM_PROMPT = [
  "Você é um revisor de textos profissional e falante nativo do idioma indicado.",
  "Seu objetivo é corrigir o texto e deixá-lo natural, como um nativo escreveria no estilo solicitado.",
  "Corrija:",
  "- Gramática, ortografia, pontuação, concordância e tempos verbais.",
  '- Construções pouco naturais, traduções literais e frases que um nativo não usaria, trocando-as pela forma idiomática equivalente (por exemplo, em inglês do dia a dia, "I married last year" deve virar "I got married last year").',
  "- Escolha de palavras e preposições, adequando-as ao estilo pedido.",
  "Regras estritas:",
  "- Devolva APENAS o texto corrigido, sem comentários, explicações, marcadores ou aspas adicionais.",
  "- Preserve o sentido e a intenção originais; não invente nem remova fatos.",
  "- Preserve quebras de linha e a estrutura de parágrafos do texto original.",
  "- Só devolva o texto sem alterações se ele já estiver correto E natural para o estilo pedido.",
].join(" ");

// Descrição detalhada de cada estilo. Passar só a palavra (ex.: "Simples")
// deixava o modelo sem referência do registro esperado — ele tratava "Simples"
// como "mexer o mínimo possível" e não naturalizava expressões pouco
// idiomáticas (ex.: "I married last year" ficava intacto). Cada estilo abaixo
// define o registro e o nível de intervenção esperados.
const STYLE_GUIDES: Record<string, string> = {
  Simples:
    'Estilo "Simples": linguagem do dia a dia, clara e direta, do jeito que um falante nativo fala e escreve no cotidiano. Prefira palavras comuns e frases naturais; corrija construções pouco idiomáticas para a forma usada na fala do dia a dia, mesmo quando a original for tecnicamente compreensível.',
  Corporativo:
    'Estilo "Corporativo": tom profissional e cordial, adequado a e-mails e documentos de trabalho. Claro, objetivo e educado, sem gírias, porém sem a formalidade de um texto acadêmico.',
  Acadêmico:
    'Estilo "Acadêmico": tom formal e preciso, com vocabulário culto e estrutura bem articulada, adequado a textos técnicos e científicos. Evite gírias e coloquialismos.',
  Coloquial:
    'Estilo "Coloquial": tom casual e descontraído, como uma conversa entre amigos. Use expressões idiomáticas e contrações comuns, mantendo a naturalidade da fala informal.',
};

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

  // A key do OpenRouter é composta apenas por caracteres ASCII imprimíveis
  // (ex.: "sk-or-v1-...."). Ao colar a key no painel da Vercel é comum entrar
  // junto algum caractere invisível — quebra de linha no meio do valor (o
  // campo quebra linhas longas), espaço, NBSP, zero-width space ou BOM. Esses
  // caracteres geram "TypeError: Invalid header value" ao montar o header
  // Authorization. trim() só limpa as pontas, então removemos TODO caractere
  // fora da faixa ASCII imprimível, em qualquer posição.
  const apiKey = (process.env.OPENROUTER_API_KEY ?? "").replace(
    /[^\x21-\x7E]/g,
    "",
  );
  if (!apiKey) {
    return new Response(
      "OPENROUTER_API_KEY não configurada no servidor.",
      { status: 500 },
    );
  }

  const styleGuide = STYLE_GUIDES[style] ?? `Tom/estilo desejado: ${style}.`;
  const system = `${SYSTEM_PROMPT}\n\nIdioma de escrita esperado: ${language}.\n${styleGuide}`;
  const user = `Corrija o texto a seguir (idioma: ${language}; estilo: ${style}):\n\n${text}`;

  // HTTP-Referer/X-Title são opcionais no OpenRouter (só rankings). Removidos
  // para evitar qualquer "Invalid header value" vindo de valores vazios.
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

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