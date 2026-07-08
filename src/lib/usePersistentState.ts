import { useCallback, useSyncExternalStore } from "react";

// Estado persistido em localStorage, seguro para SSR/hydration.
//
// O servidor (e a primeira renderização de hidratação) usa sempre `default`,
// então o HTML do servidor casa com o do cliente — sem "hydration mismatch".
// Logo após a hidratação, o cliente lê o localStorage via useSyncExternalStore
// e re-renderiza com o valor salvo, sem gerar aviso e sem setState em effect.
//
// A escrita dispara um evento sintético "agc:storage" para sincronizar todas
// as instâncias na MESMA aba (o evento nativo "storage" só cruza abas).
const EVENT = "agc:storage";

export function usePersistentState<T extends string>(
  key: string,
  defaultValue: T,
  isValid: (value: string) => value is T,
): readonly [T, (value: T) => void] {
  const subscribe = useCallback((onStoreChange: () => void) => {
    window.addEventListener(EVENT, onStoreChange);
    window.addEventListener("storage", onStoreChange);
    return () => {
      window.removeEventListener(EVENT, onStoreChange);
      window.removeEventListener("storage", onStoreChange);
    };
  }, []);

  const getSnapshot = useCallback((): T => {
    const saved = window.localStorage.getItem(key);
    return saved !== null && isValid(saved) ? saved : defaultValue;
  }, [key, defaultValue, isValid]);

  const value = useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => defaultValue,
  );

  const setValue = useCallback(
    (next: T) => {
      window.localStorage.setItem(key, next);
      window.dispatchEvent(new Event(EVENT));
    },
    [key],
  );

  return [value, setValue] as const;
}
