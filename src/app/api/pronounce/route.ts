import { NextRequest } from "next/server";

// Mesmo padrão de /api/check: Edge runtime para streaming real com
// ReadableStream e melhor tempo limite no Hobby da Vercel.
export const runtime = "edge";
export const dynamic = "force-dynamic";

const MODEL = process.env.OPENROUTER_MODEL ?? "google/gemini-2.5-flash-lite";
const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

// Regras de formato da resposta. Pedimos texto simples (sem markdown) para
// renderizar com a mesma estética do restante do app (.preserve-lines).
const FORMAT_RULES = [
  "Você é um professor de inglês e foneticista brasileiro, especialista em ensinar a pronúncia do inglês para falantes de português do Brasil.",
  "Receberá uma palavra ou frase em inglês e deve produzir a pronúncia APENAS no sotaque solicitado.",
  "A pronúncia deve refletir a fala real do dia a dia (fala conectada) daquele sotaque — não apenas a forma isolada de dicionário quando houver diferença.",
  "Responda SEMPRE em texto simples (sem markdown, sem crases), exatamente neste formato e nesta ordem:",
  "IPA: <transcrição fonética entre colchetes [ ], com tônica primária ˈ e secundária ˌ>",
  "Pronúncia (leia em português): <reescrita usando a ORTOGRAFIA DO PORTUGUÊS DO BRASIL, seguindo o GUIA DE GRAFIA abaixo>",
  "Regras aplicadas:",
  "- <um tópico curto para CADA regra de fala realmente aplicada nesta entrada, citando a palavra/trecho afetado>",
  "A linha 'IPA' é apenas a referência técnica. A linha 'Pronúncia' é a MAIS IMPORTANTE: um brasileiro deve conseguir lê-la em voz alta, como se fosse português, e chegar perto do som real em inglês. NUNCA use símbolos de IPA na linha 'Pronúncia'.",
  "Em 'Regras aplicadas' liste APENAS regras que de fato ocorrem nesta entrada e neste sotaque; explique em linguagem simples para um brasileiro; não invente.",
  "Para frases, forneça o IPA e a Pronúncia da frase inteira em fala conectada e cite ligações/assimilações relevantes nas regras.",
  "Não escreva nenhum texto fora desse formato (sem saudações, sem observações extras, sem repetir a entrada).",
].join("\n");

// GUIA DE GRAFIA em português do Brasil para a linha "Pronúncia". A ideia é
// aproveitar a própria fonética do PT-BR: por exemplo, o "r" entre vogais do
// português já é um tepe [ɾ] — exatamente o "flap T" americano de "water".
const RESPELLING_GUIDE = [
  "GUIA DE GRAFIA (linha 'Pronúncia', para brasileiros):",
  "- Reescreva o som com a ortografia do português do Brasil; separe as sílabas por hífen e escreva a sílaba TÔNICA em MAIÚSCULAS.",
  "- Use os acentos do português nas vogais: á, é (aberto), ê (fechado), í, ó (aberto), ô (fechado), u.",
  "Vogais (aproximações):",
  "- /iː/ e /ɪ/ -> 'i' (see = 'SÍ', sit = 'SIT').",
  "- /e ɛ/ -> 'é' (bed = 'BÉD'); /æ/ -> 'é' puxando para 'a' (cat = 'KÉT', man = 'MÉN').",
  "- /ʌ/ e o schwa /ə/ (vogal fraca) -> 'â' (cup = 'CÂP', about = 'â-BÁUT', banana = 'bâ-NÉ-nâ').",
  "- /ɑː/ -> 'á' (father = 'FÁ-dâr'); /ɒ/ britânico -> 'ó' (hot = 'RÓT'); /ɔː/ -> 'ó' (law = 'LÓ', dog = 'DÓG').",
  "- /ʊ/ e /uː/ -> 'u' (put = 'PUT', blue = 'BLÚ', school = 'SCÚL').",
  "Ditongos: /eɪ/ = 'êi' (day = 'DÊI'); /aɪ/ = 'ái' (my = 'MÁI'); /ɔɪ/ = 'ói' (boy = 'BÓI'); /aʊ/ = 'áu' (now = 'NÁU'); /oʊ/ (EUA) e /əʊ/ (RU) = 'ôu' (go = 'GÔU').",
  "Consoantes que confundem o brasileiro:",
  "- 'h' inglês (house, hello): grafe como 'r' de início de sílaba do português (o 'r' de 'rato'), que dá o sopro certo: house = 'RÁUS', hello = 'râ-LÔU'.",
  "- 'r' consoante do inglês (red, run): grafe 'ré'/'r', mas avise que é o 'r' do inglês (língua enrolada para trás), NÃO o 'rr' forte do português: red = 'RÉD (r do inglês)'.",
  "- 'th' surdo /θ/ (think, thing): grafe 't' e avise '(língua entre os dentes)': think = 'TÍNK (língua entre os dentes)'.",
  "- 'th' sonoro /ð/ (this, the): grafe 'd' e avise '(língua entre os dentes)': this = 'DÍS', the = 'dâ'.",
  "- 'w' -> 'u' (we = 'UÍ', water = 'UÓ-...'); 'v' continua 'v'. No inglês indiano, 'v' e 'w' podem soar iguais.",
  "- Flap T / D americano (t ou d entre vogais) soa como o 'r' batido de 'cara'/'para': water (EUA) = 'UÓ-rer', city (EUA) = 'SÍ-ri', better (EUA) = 'BÉ-rer'.",
  "- Stop T americano (button, mountain): o 't' é 'engolido' com um corte na garganta; marque com apóstrofo e avise: button = 'BÂ-ân (t engolido)', mountain = 'MÁUN-ân (t engolido)'.",
  "- Consoante final muda pouco: escreva o som real do fim da palavra (make = 'MÊIK', dogs = 'DÓGS').",
  "IMPORTANTE: a linha 'Pronúncia' deve refletir o MESMO sotaque do IPA. Ex.: britânico é não-rótico, então NÃO leva 'r' no fim (water RU = 'UÓ-tâ'); americano leva o 'r' e o flap (water EUA = 'UÓ-rer').",
].join("\n");

// Exemplos few-shot: fixam o formato e o estilo da reescrita em PT-BR.
const EXAMPLES = [
  "EXEMPLOS (apenas para mostrar o formato; o sotaque de cada exemplo está entre parênteses):",
  "",
  "water (Inglês americano)",
  "IPA: [ˈwɑːɾɚ]",
  "Pronúncia (leia em português): UÓ-rer  — o 'r' do meio é batido, como em 'cara'",
  "Regras aplicadas:",
  "- Flap T: o 't' entre vogais vira 'r' batido [ɾ], igual ao 'r' de 'para'.",
  "- Rótico: o 'r' final é pronunciado.",
  "",
  "water (Inglês britânico)",
  "IPA: [ˈwɔːtə]",
  "Pronúncia (leia em português): UÓ-tâ  — sem 'r' no fim; termina num 'â' fraco",
  "Regras aplicadas:",
  "- Não-rótico: o 'r' final não é pronunciado.",
  "- 't' claro (sem flap).",
  "",
  "thanks (Inglês americano)",
  "IPA: [θæŋks]",
  "Pronúncia (leia em português): TÊNKS  — comece com a língua entre os dentes no 'th'",
  "Regras aplicadas:",
  "- 'th' surdo: som feito com a língua entre os dentes (não é 'f' nem 't' comum).",
].join("\n");

// Características fonológicas de cada sotaque. É o que garante que a pronúncia
// seja "exatamente aquela aplicada no idioma selecionado" (stop T, flap T,
// não-rótico, retroflexo, etc.).
const ACCENT_RULES: Record<string, { name: string; rules: string }> = {
  american: {
    name: "Inglês americano (General American)",
    rules: [
      "Características obrigatórias deste sotaque:",
      "- Rótico: pronuncie todos os /r/; use vogais rotacizadas ɚ (átona) e ɝ (tônica).",
      "- Flap T (tepe [ɾ]): /t/ e /d/ entre vogais viram tepe — water [ˈwɑɾɚ], better [ˈbɛɾɚ], city [ˈsɪɾi].",
      "- Stop T (oclusiva glotal [ʔ]): /t/ antes de /n/ silábico ou em fim de sílaba — button [ˈbʌʔn̩], mountain [ˈmaʊʔn̩], cat [kʰæʔt] (t não solto).",
      "- Yod-dropping após t, d, n, s — new [nu], Tuesday [ˈtuzdeɪ], student [ˈstudn̩t].",
      "- Vogais: æ (trap), ɑ (lot/palm), ɔ~ɑ (thought); reduza átonas a ə/ɪ; 'dark L' [ɫ] em coda.",
    ].join("\n"),
  },
  british: {
    name: "Inglês britânico (Received Pronunciation)",
    rules: [
      "Características obrigatórias deste sotaque:",
      "- NÃO rótico: não pronuncie /r/ em fim de sílaba/palavra — car [kɑː], water [ˈwɔːtə], letter [ˈlɛtə].",
      "- R de ligação e R intrusivo entre vogais — far away [ˌfɑːr əˈweɪ], law and order [ˌlɔːr ənd ˈɔːdə].",
      "- SEM flap T: mantenha [t] claro — water [ˈwɔːtə], better [ˈbɛtə].",
      "- Trap–bath split — bath [bɑːθ], dance [dɑːns], can't [kɑːnt].",
      "- Vogal LOT arredondada curta ɒ — lot [lɒt], not [nɒt].",
      "- Retenção do yod — new [njuː], Tuesday [ˈtjuːzdeɪ], duke [djuːk]; ditongo goat [ɡəʊt].",
    ].join("\n"),
  },
  indian: {
    name: "Inglês indiano (Indian English)",
    rules: [
      "Características obrigatórias deste sotaque:",
      "- Oclusivas retroflexas: /t/ -> [ʈ] e /d/ -> [ɖ] — time [ʈaɪm], dog [ɖɔɡ].",
      "- TH vira oclusiva dental: /θ/ -> [t̪] (think [t̪ɪŋk]) e /ð/ -> [d̪] (this [d̪ɪs]).",
      "- /v/ e /w/ tendem à aproximante labiodental [ʋ] — very/wet com [ʋ].",
      "- Ritmo silábico: pouca redução vocálica — vogais átonas mantêm valor pleno (menos schwa).",
      "- Monotongação: face [feːs] (eɪ->eː), goat [ɡoːʈ] (oʊ->oː).",
      "- Geralmente rótico, com /r/ como tepe/vibrante [ɾ]/[r]; NÃO use flap/stop T do inglês americano.",
    ].join("\n"),
  },
};

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response("JSON inválido", { status: 400 });
  }

  const { text, accent } = (body ?? {}) as {
    text?: string;
    accent?: string;
  };

  if (typeof text !== "string" || !text.trim()) {
    return new Response("Texto vazio", { status: 400 });
  }
  if (typeof accent !== "string" || !ACCENT_RULES[accent]) {
    return new Response("Sotaque inválido", { status: 400 });
  }

  // Mesma sanitização de /api/check: remove qualquer caractere fora da faixa
  // ASCII imprimível para evitar "Invalid header value" ao montar o header.
  const apiKey = (process.env.OPENROUTER_API_KEY ?? "").replace(
    /[^\x21-\x7E]/g,
    "",
  );
  if (!apiKey) {
    return new Response("OPENROUTER_API_KEY não configurada no servidor.", {
      status: 500,
    });
  }

  const selected = ACCENT_RULES[accent];
  const system = `${FORMAT_RULES}\n\n${RESPELLING_GUIDE}\n\n${EXAMPLES}\n\nSOTAQUE SOLICITADO: ${selected.name}.\n${selected.rules}`;
  const user = `Transcreva a pronúncia (no sotaque ${selected.name}) de:\n\n${text}`;

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
        max_tokens: Math.max(256, Math.min(1024, text.length * 20)),
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
  } catch (err) {
    const msg =
      err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return new Response(`Falha ao contatar o OpenRouter: ${msg}`, {
      status: 502,
    });
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

  // Converte o SSE do OpenRouter num stream de texto puro, igual a /api/check.
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
              const delta: string | undefined =
                json?.choices?.[0]?.delta?.content;
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
