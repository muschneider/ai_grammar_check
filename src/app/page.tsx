"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Language = {
  value: string;
  label: string;
};

const LANGUAGES: Language[] = [
  { value: "Português do Brasil (pt-BR)", label: "Português (Brasil)" },
  { value: "Português de Portugal (pt-PT)", label: "Português (Portugal)" },
  { value: "Inglês americano (en-US)", label: "Inglês (EUA)" },
  { value: "Inglês britânico (en-GB)", label: "Inglês (Reino Unido)" },
  { value: "Espanhol da Espanha (es-ES)", label: "Espanhol (Espanha)" },
  { value: "Espanhol latino-americano (es-419)", label: "Espanhol (Latino)" },
  { value: "Francês (fr-FR)", label: "Francês" },
  { value: "Alemão (de-DE)", label: "Alemão" },
  { value: "Italiano (it-IT)", label: "Italiano" },
];

const STYLES = ["Simples", "Corporativo", "Acadêmico", "Coloquial"] as const;
type Style = (typeof STYLES)[number];

// Heurística de gatilho:
//  - QUICK_MS: delay curto usado quando o último caractere é um separador
//    de palavra (espaço, pontuação) => "terminou de digitar uma palavra".
//  - IDLE_MS:  delay maior usado enquanto digita-se no meio de uma palavra
//    => "ficou um determinado tempo sem digitar".
const QUICK_MS = 250;
const IDLE_MS = 1500;

// Caracteres que delimitam uma palavra/frase para a heurística.
const WORD_BOUNDARY =
  /[\s.,;:!?\u2026\u2013\u2014()\[\]{}"'«»#\u00bf\u00a1\u00ab\u00bb]$/;

function pickDelay(value: string): number {
  return WORD_BOUNDARY.test(value) ? QUICK_MS : IDLE_MS;
}

export default function Home() {
  const [text, setText] = useState("");
  const [language, setLanguage] = useState(LANGUAGES[0].value);
  const [style, setStyle] = useState<Style>("Simples");

  const [output, setOutput] = useState("");
  const [status, setStatus] = useState<
    "idle" | "loading" | "streaming" | "error"
  >("idle");
  const [error, setError] = useState<string>("");

  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Buffer de chunks + rAF: agrupa múltiplos deltas em uma única atualação de
  // estado por frame, reduzindo drasticamente as re-renderizações do React.
  const bufferRef = useRef("");
  const rafRef = useRef<number | null>(null);

  const trimmed = text.trim();
  const changed = useMemo(
    () => output !== "" && output !== trimmed,
    [output, trimmed],
  );

  const flushBuffer = useCallback(() => {
    rafRef.current = null;
    if (bufferRef.current) {
      const piece = bufferRef.current;
      bufferRef.current = "";
      setOutput((prev) => prev + piece);
    }
  }, []);

  const scheduleFlush = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(flushBuffer);
  }, [flushBuffer]);

  const runCheck = useCallback(
    async (value: string, lang: string, st: Style) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      bufferRef.current = "";
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }

      setOutput("");
      setError("");
      setStatus("loading");

      try {
        const res = await fetch("/api/check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: value,
            language: lang,
            style: st,
          }),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          const msg = await res.text().catch(() => "Erro desconhecido");
          setStatus("error");
          setError(msg || `Erro ${res.status}`);
          return;
        }

        setStatus("streaming");
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          const piece = decoder.decode(chunk, { stream: true });
          if (piece) {
            bufferRef.current += piece;
            scheduleFlush();
          }
        }
        // flush final síncrono para garantir o conteúdo restante.
        flushBuffer();
        setStatus("idle");
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setStatus("error");
        setError((err as Error).message || "Falha na requisição");
      }
    },
    [flushBuffer, scheduleFlush],
  );

  // Correção automática com heurística:
  //   1) ao digitar o último caractere como separador de palavra → dispara após QUICK_MS;
  //   2) enquanto digita no meio de uma palavra → dispara após IDLE_MS de inatividade.
  // Cada nova tecla reinicia o contador (idle reset).
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!trimmed) return;
    const delay = pickDelay(text);
    debounceRef.current = setTimeout(() => {
      void runCheck(text, language, style);
    }, delay);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [text, language, style, trimmed, runCheck]);

  const handleClear = () => {
    abortRef.current?.abort();
    setText("");
    setOutput("");
    setError("");
    setStatus("idle");
  };

  const handleTextChange = (value: string) => {
    setText(value);
    if (!value.trim()) {
      abortRef.current?.abort();
      setOutput("");
      setError("");
      setStatus("idle");
    }
  };

  const handleCopy = async () => {
    if (!output) return;
    try {
      await navigator.clipboard.writeText(output);
    } catch {
      /* ignora */
    }
  };

  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    window.location.href = "/login";
  };

  return (
    <main className="flex flex-1 flex-col">
      <header className="border-b border-zinc-200 bg-white/70 backdrop-blur dark:border-zinc-800 dark:bg-black/40">
        <div className="mx-auto flex max-w-6xl flex-col gap-1 px-6 py-5">
          <h1 className="text-2xl font-semibold tracking-tight">
            AI Grammar Check
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Correção gramatical e de estilo em tempo real, alimentada por IA
            via OpenRouter.
          </p>
        </div>
        <button
          type="button"
          onClick={handleLogout}
          className="absolute right-6 top-5 rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
        >
          Sair
        </button>
      </header>

      <section className="mx-auto grid w-full max-w-6xl flex-1 grid-cols-1 gap-4 px-6 py-6 lg:grid-cols-2">
        {/* Coluna de entrada */}
        <div className="flex flex-col rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex flex-wrap items-center gap-3 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
            <label className="flex flex-col gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">
              Idioma
              <select
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 shadow-sm focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              >
                {LANGUAGES.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">
              Estilo
              <select
                value={style}
                onChange={(e) => setStyle(e.target.value as Style)}
                className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 shadow-sm focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              >
                {STYLES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="button"
              onClick={handleClear}
              className="ml-auto rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
            >
              Limpar
            </button>
          </div>

          <textarea
            value={text}
            onChange={(e) => handleTextChange(e.target.value)}
            placeholder="Digite ou cole aqui o seu texto…"
            spellCheck={false}
            className="preserve-lines min-h-[18rem] flex-1 resize-none bg-transparent px-4 py-3 text-base leading-7 text-zinc-900 placeholder:text-zinc-400 focus:outline-none dark:text-zinc-100 dark:placeholder:text-zinc-600"
          />
          <div className="border-t border-zinc-200 px-4 py-2 text-right text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
            {text.length} caracteres · {text.trim() ? text.trim().split(/\s+/).length : 0} palavras
          </div>
        </div>

        {/* Coluna de correção */}
        <div className="flex flex-col rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
            <div className="flex items-center gap-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">
              <span
                className={[
                  "inline-block h-2 w-2 rounded-full",
                  status === "idle" && "bg-zinc-400",
                  status === "loading" && "bg-amber-400 animate-pulse",
                  status === "streaming" && "bg-emerald-500 animate-pulse",
                  status === "error" && "bg-red-500",
                ]
                  .filter(Boolean)
                  .join(" ")}
              />
              {status === "idle" && "Pronto"}
              {status === "loading" && "Corrigindo…"}
              {status === "streaming" && "Corrigindo…"}
              {status === "error" && "Erro"}
            </div>
            <button
              type="button"
              onClick={handleCopy}
              disabled={!output}
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
            >
              Copiar
            </button>
          </div>

          <div className="preserve-lines min-h-[18rem] flex-1 px-4 py-3 text-base leading-7">
            {output ? (
              <span
                className={status === "streaming" ? "opacity-95" : undefined}
              >
                {output}
                {status === "streaming" && (
                  <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-zinc-400 align-middle dark:bg-zinc-500" />
                )}
              </span>
            ) : status === "error" ? (
              <span className="text-red-600 dark:text-red-400">
                {error || "Não foi possível corrigir o texto."}
              </span>
            ) : status === "loading" ? (
              <span className="text-zinc-400 dark:text-zinc-600">
                Analisando o texto…
              </span>
            ) : changed ? null : (
              <span className="text-zinc-400 dark:text-zinc-600">
                O texto corrigido aparecerá aqui automaticamente enquanto você
                digita.
              </span>
            )}
          </div>
          <div className="border-t border-zinc-200 px-4 py-2 text-right text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
            {output.length} caracteres ·{" "}
            {output.trim() ? output.trim().split(/\s+/).length : 0} palavras
          </div>
        </div>
      </section>

      <footer className="border-t border-zinc-200 px-6 py-3 text-center text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
        Modelo: <code className="font-mono">google/gemini-2.5-flash-lite</code>{" "}
        via OpenRouter · Gatilho: {QUICK_MS}ms (fim de palavra) / {IDLE_MS}ms
        (inatividade)
      </footer>
    </main>
  );
}