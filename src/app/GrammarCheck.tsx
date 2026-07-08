"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePersistentState } from "@/lib/usePersistentState";

type Language = {
  value: string;
  label: string;
};

const LANG_KEY = "agc:language";
const STYLE_KEY = "agc:style";

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

const isLanguage = (v: string): v is string =>
  LANGUAGES.some((l) => l.value === v);
const isStyle = (v: string): v is Style =>
  (STYLES as readonly string[]).includes(v);

// Heurística de gatilho da correção automática:
//  - SENTENCE_MS: delay curto-moderado quando o texto termina uma frase
//    (. ! ? … ou nova linha) => provável pausa real do usuário.
//  - IDLE_MS:     delay maior para qualquer outra digitação (inclui espaço)
//    => só dispara depois que o usuário fica realmente parado.
//  - MIN_CHARS:   comprimento mínimo para o disparo automático, evitando
//    gastar tokens com fragmentos iniciais.
// O espaço entre palavras deixou de ser gatilho (causava checagens no meio
// da frase a cada palavra digitada).
const SENTENCE_MS = 800;
const IDLE_MS = 2000;
const MIN_CHARS = 8;

// Fim de frase real, permitindo espaços/quebras ao final.
const SENTENCE_END = /[.!?\u2026\n]\s*$/;

function pickDelay(value: string): number {
  return SENTENCE_END.test(value) ? SENTENCE_MS : IDLE_MS;
}

export default function GrammarCheck() {
  const [text, setText] = useState("");
  // Persistido em localStorage de forma segura para SSR/hydration.
  const [language, setLanguage] = usePersistentState(
    LANG_KEY,
    LANGUAGES[0].value,
    isLanguage,
  );
  const [style, setStyle] = usePersistentState<Style>(
    STYLE_KEY,
    "Simples",
    isStyle,
  );

  const [output, setOutput] = useState("");
  const [status, setStatus] = useState<
    "idle" | "loading" | "streaming" | "error"
  >("idle");
  const [error, setError] = useState<string>("");

  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Última assinatura (idioma|estilo|texto) já enviada para correção. Evita
  // reprocessar conteúdo idêntico (ex.: digitar um espaço e apagar).
  const lastCheckedRef = useRef<string>("");
  // Sinaliza composição IME (acentos, teclados mobile/asiáticos) em andamento.
  const isComposingRef = useRef(false);

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
        // Libera a dedup para permitir nova tentativa automática ao digitar.
        lastCheckedRef.current = "";
        setStatus("error");
        setError((err as Error).message || "Falha na requisição");
      }
    },
    [flushBuffer, scheduleFlush],
  );

  // Agenda a correção automática conforme a heurística e as guardas:
  //   - ignora texto vazio, curto demais ou em composição (IME);
  //   - deduplica: não reprocessa a mesma assinatura idioma|estilo|texto;
  //   - delay curto ao fim de frase, maior durante a digitação.
  // Cada nova tecla reinicia o contador (idle reset).
  const scheduleAutoCheck = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!trimmed) return;
    if (isComposingRef.current) return;
    if (trimmed.length < MIN_CHARS) return;
    const sig = `${language}|${style}|${trimmed}`;
    if (sig === lastCheckedRef.current) return;
    const delay = pickDelay(text);
    debounceRef.current = setTimeout(() => {
      lastCheckedRef.current = sig;
      void runCheck(text, language, style);
    }, delay);
  }, [text, trimmed, language, style, runCheck]);

  useEffect(() => {
    scheduleAutoCheck();
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [scheduleAutoCheck]);

  // Dispara imediatamente (Ctrl/Cmd+Enter), ignorando debounce, mínimo e dedup.
  const triggerNow = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const t = text.trim();
    if (!t) return;
    lastCheckedRef.current = `${language}|${style}|${t}`;
    void runCheck(text, language, style);
  }, [text, language, style, runCheck]);

  const handleClear = () => {
    abortRef.current?.abort();
    lastCheckedRef.current = "";
    setText("");
    setOutput("");
    setError("");
    setStatus("idle");
  };

  const handleTextChange = (value: string) => {
    setText(value);
    if (!value.trim()) {
      abortRef.current?.abort();
      lastCheckedRef.current = "";
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

  return (
    <>
      <section className="mx-auto flex w-full max-w-[1800px] flex-1 flex-col gap-3 px-4 py-3 sm:gap-4 sm:px-6 sm:py-4 md:min-h-0 md:flex-row">
        {/* Coluna de entrada */}
        <div className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm md:flex-1 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex shrink-0 flex-wrap items-end gap-2 border-b border-zinc-200 px-3 py-3 sm:gap-3 sm:px-4 dark:border-zinc-800">
            <label className="flex flex-1 basis-32 flex-col gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">
              Idioma
              <select
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                className="w-full rounded-md border border-zinc-300 bg-white px-2 py-2 text-base text-zinc-900 shadow-sm focus:border-zinc-500 focus:outline-none sm:py-1.5 sm:text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              >
                {LANGUAGES.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-1 basis-32 flex-col gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">
              Estilo
              <select
                value={style}
                onChange={(e) => setStyle(e.target.value as Style)}
                className="w-full rounded-md border border-zinc-300 bg-white px-2 py-2 text-base text-zinc-900 shadow-sm focus:border-zinc-500 focus:outline-none sm:py-1.5 sm:text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
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
              className="ml-auto rounded-md border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
            >
              Limpar
            </button>
          </div>

          <textarea
            value={text}
            onChange={(e) => handleTextChange(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                triggerNow();
              }
            }}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={() => {
              isComposingRef.current = false;
              scheduleAutoCheck();
            }}
            placeholder="Digite ou cole aqui o seu texto…"
            spellCheck={false}
            className="preserve-lines min-h-[14rem] flex-1 resize-none overflow-auto bg-transparent px-4 py-3 text-base leading-7 text-zinc-900 placeholder:text-zinc-400 focus:outline-none md:min-h-0 dark:text-zinc-100 dark:placeholder:text-zinc-600"
          />
          <div className="shrink-0 border-t border-zinc-200 px-4 py-2 text-right text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
            {text.length} caracteres ·{" "}
            {text.trim() ? text.trim().split(/\s+/).length : 0} palavras
          </div>
        </div>

        {/* Coluna de correção */}
        <div className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm md:flex-1 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex shrink-0 items-center justify-between border-b border-zinc-200 px-3 py-3 sm:px-4 dark:border-zinc-800">
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
              className="rounded-md border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
            >
              Copiar
            </button>
          </div>

          <div className="preserve-lines min-h-[14rem] flex-1 overflow-auto px-4 py-3 text-base leading-7 md:min-h-0">
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
          <div className="shrink-0 border-t border-zinc-200 px-4 py-2 text-right text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
            {output.length} caracteres ·{" "}
            {output.trim() ? output.trim().split(/\s+/).length : 0} palavras
          </div>
        </div>
      </section>

      <footer className="shrink-0 border-t border-zinc-200 px-4 py-2.5 text-center text-xs text-zinc-500 sm:px-6 dark:border-zinc-800 dark:text-zinc-400">
        Modelo: <code className="font-mono">google/gemini-2.5-flash-lite</code>{" "}
        via OpenRouter · Gatilho: {SENTENCE_MS}ms (fim de frase) / {IDLE_MS}ms
        (inatividade) · mín. {MIN_CHARS} caracteres ·{" "}
        <kbd className="font-mono">Ctrl/Cmd+Enter</kbd> para corrigir agora
      </footer>
    </>
  );
}
