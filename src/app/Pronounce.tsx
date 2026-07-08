"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePersistentState } from "@/lib/usePersistentState";

type Accent = {
  value: string;
  label: string;
};

const ACCENT_KEY = "agc:accent";

// value = chave enviada à API (deve casar com ACCENT_RULES em /api/pronounce).
const ACCENTS: Accent[] = [
  { value: "american", label: "Inglês americano" },
  { value: "british", label: "Inglês britânico" },
  { value: "indian", label: "Inglês indiano" },
];

const isAccent = (v: string): v is string =>
  ACCENTS.some((a) => a.value === v);

// Gatilho automático: a entrada costuma ser curta (uma palavra), então o
// mínimo é baixo e o debounce é único — não há heurística de fim de frase.
const IDLE_MS = 700;
const MIN_CHARS = 2;

export default function Pronounce() {
  const [text, setText] = useState("");
  // Persistido em localStorage de forma segura para SSR/hydration.
  const [accent, setAccent] = usePersistentState(
    ACCENT_KEY,
    ACCENTS[0].value,
    isAccent,
  );

  const [output, setOutput] = useState("");
  const [status, setStatus] = useState<
    "idle" | "loading" | "streaming" | "error"
  >("idle");
  const [error, setError] = useState<string>("");

  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Última assinatura (sotaque|texto) já transcrita. Evita reprocessar a mesma
  // entrada (ex.: digitar um espaço e apagar, ou voltar ao mesmo sotaque).
  const lastCheckedRef = useRef<string>("");
  // Sinaliza composição IME (acentos, teclados mobile) em andamento.
  const isComposingRef = useRef(false);

  // Buffer de chunks + rAF: agrupa deltas em uma atualização por frame.
  const bufferRef = useRef("");
  const rafRef = useRef<number | null>(null);

  const trimmed = text.trim();

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

  const runPronounce = useCallback(
    async (value: string, acc: string) => {
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
        const res = await fetch("/api/pronounce", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: value, accent: acc }),
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

  // Agenda a transcrição automática. Também dispara ao trocar de sotaque,
  // pois `accent` está nas dependências. Deduplica por sotaque|texto.
  const scheduleAuto = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!trimmed) return;
    if (isComposingRef.current) return;
    if (trimmed.length < MIN_CHARS) return;
    const sig = `${accent}|${trimmed}`;
    if (sig === lastCheckedRef.current) return;
    debounceRef.current = setTimeout(() => {
      lastCheckedRef.current = sig;
      void runPronounce(text, accent);
    }, IDLE_MS);
  }, [text, trimmed, accent, runPronounce]);

  useEffect(() => {
    scheduleAuto();
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [scheduleAuto]);

  // Dispara imediatamente (Ctrl/Cmd+Enter), ignorando debounce, mínimo e dedup.
  const triggerNow = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const t = text.trim();
    if (!t) return;
    lastCheckedRef.current = `${accent}|${t}`;
    void runPronounce(text, accent);
  }, [text, accent, runPronounce]);

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

  const accentLabel = ACCENTS.find((a) => a.value === accent)?.label;

  return (
    <>
      <section className="mx-auto flex w-full max-w-[1800px] flex-1 flex-col gap-3 px-4 py-3 sm:gap-4 sm:px-6 sm:py-4 md:min-h-0 md:flex-row">
        {/* Coluna de entrada */}
        <div className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm md:flex-1 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex shrink-0 flex-wrap items-end gap-2 border-b border-zinc-200 px-3 py-3 sm:gap-3 sm:px-4 dark:border-zinc-800">
            <label className="flex flex-1 basis-32 flex-col gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">
              Sotaque
              <select
                value={accent}
                onChange={(e) => setAccent(e.target.value)}
                className="w-full rounded-md border border-zinc-300 bg-white px-2 py-2 text-base text-zinc-900 shadow-sm focus:border-zinc-500 focus:outline-none sm:py-1.5 sm:text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              >
                {ACCENTS.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.label}
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
              scheduleAuto();
            }}
            placeholder="Digite uma palavra ou frase em inglês…"
            spellCheck={false}
            className="preserve-lines min-h-[14rem] flex-1 resize-none overflow-auto bg-transparent px-4 py-3 text-base leading-7 text-zinc-900 placeholder:text-zinc-400 focus:outline-none md:min-h-0 dark:text-zinc-100 dark:placeholder:text-zinc-600"
          />
          <div className="shrink-0 border-t border-zinc-200 px-4 py-2 text-right text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
            {text.length} caracteres ·{" "}
            {text.trim() ? text.trim().split(/\s+/).length : 0} palavras
          </div>
        </div>

        {/* Coluna de pronúncia */}
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
              {status === "loading" && "Transcrevendo…"}
              {status === "streaming" && "Transcrevendo…"}
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
                {error || "Não foi possível gerar a pronúncia."}
              </span>
            ) : status === "loading" ? (
              <span className="text-zinc-400 dark:text-zinc-600">
                Analisando a pronúncia…
              </span>
            ) : (
              <span className="text-zinc-400 dark:text-zinc-600">
                A pronúncia fonética e o IPA aparecerão aqui automaticamente
                enquanto você digita.
              </span>
            )}
          </div>
          <div className="shrink-0 border-t border-zinc-200 px-4 py-2 text-right text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
            Sotaque: {accentLabel}
          </div>
        </div>
      </section>

      <footer className="shrink-0 border-t border-zinc-200 px-4 py-2.5 text-center text-xs text-zinc-500 sm:px-6 dark:border-zinc-800 dark:text-zinc-400">
        Pronúncia fonética + IPA por sotaque (EUA · Reino Unido · Índia) · aplica
        regras da fala real (ex.: <em>stop T</em>, <em>flap T</em>, não-rótico,
        retroflexo) · <kbd className="font-mono">Ctrl/Cmd+Enter</kbd> para
        transcrever agora
      </footer>
    </>
  );
}
