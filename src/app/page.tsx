"use client";

import { usePersistentState } from "@/lib/usePersistentState";
import GrammarCheck from "./GrammarCheck";
import Pronounce from "./Pronounce";

type Tab = "grammar" | "pronounce";
const TAB_KEY = "agc:tab";
const isTab = (v: string): v is Tab => v === "grammar" || v === "pronounce";

export default function Home() {
  // Persistido em localStorage de forma segura para SSR/hydration.
  const [tab, setTab] = usePersistentState<Tab>(TAB_KEY, "grammar", isTab);

  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    window.location.href = "/login";
  };

  const tabClass = (id: Tab) =>
    [
      "rounded-md px-3 py-1.5 text-sm font-medium transition",
      tab === id
        ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
        : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900",
    ].join(" ");

  return (
    <main className="flex min-h-dvh flex-1 flex-col md:h-dvh md:overflow-hidden">
      <h1 className="sr-only">AI Grammar Check</h1>

      {/* Seletor de modo + sair (compartilhados entre as duas ferramentas) */}
      <div className="mx-auto flex w-full max-w-[1800px] items-center justify-between gap-3 px-4 pt-3 sm:px-6 sm:pt-4">
        <div
          role="tablist"
          aria-label="Modo"
          className="inline-flex gap-1 rounded-lg border border-zinc-200 bg-white p-1 shadow-sm dark:border-zinc-800 dark:bg-zinc-950"
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab === "grammar"}
            onClick={() => setTab("grammar")}
            className={tabClass("grammar")}
          >
            Correção
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "pronounce"}
            onClick={() => setTab("pronounce")}
            className={tabClass("pronounce")}
          >
            Pronúncia
          </button>
        </div>

        <button
          type="button"
          onClick={handleLogout}
          className="rounded-md border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
        >
          Sair
        </button>
      </div>

      {tab === "grammar" ? <GrammarCheck /> : <Pronounce />}
    </main>
  );
}
