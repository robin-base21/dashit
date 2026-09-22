import { createContext } from "svelte";
import { MediaQuery } from "svelte/reactivity";

export type ThemePreference = "light" | "dark" | "system";
export const THEME_KEY = "dashit-theme";

function readPreference(): ThemePreference {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    // storage unavailable
  }
  return "system";
}

/** Per-browser appearance preference; applied as the `.dark` class on <html>. */
export class Theme {
  preference = $state<ThemePreference>(readPreference());
  #systemDark = new MediaQuery("prefers-color-scheme: dark");

  readonly resolved = $derived<"light" | "dark">(
    this.preference === "system" ? (this.#systemDark.current ? "dark" : "light") : this.preference,
  );

  /** Syncs the DOM; called from an effect in the root layout. */
  apply(): void {
    document.documentElement.classList.toggle("dark", this.resolved === "dark");
    document.documentElement.style.colorScheme = this.resolved;
  }

  set(pref: ThemePreference): void {
    this.preference = pref;
    try {
      if (pref === "system") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, pref);
    } catch {
      // storage unavailable
    }
  }
}

export const [getTheme, setTheme] = createContext<Theme>();
