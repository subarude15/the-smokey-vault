/**
 * Appearance is Light + Dark only.
 * Obsolete persisted values (punk, angels, anything else) resolve to Dark.
 */

export type ThemeName = "light" | "dark";

export const THEME_NAMES = ["light", "dark"] as const satisfies readonly ThemeName[];

export const themePresets: Record<ThemeName, Record<string, string>> = {
  /* Light: cool stone + smoked copper — avoids cream/terracotta AI cluster */
  light: {
    "--bg": "#e9e7e2",
    "--surface": "#f6f5f2",
    "--surface-2": "#dedad3",
    "--text": "#1c1b19",
    "--muted": "#6a6660",
    "--line": "#c9c4bb",
    "--accent": "#8f5a38",
    "--accent-2": "#b8894a"
  },
  dark: {
    "--bg": "#0e0d0b",
    "--surface": "#171511",
    "--surface-2": "#221f1a",
    "--text": "#f3ebe0",
    "--muted": "#a09484",
    "--line": "#353028",
    "--accent": "#c27040",
    "--accent-2": "#d9ae6a"
  }
};

/** Map any persisted / legacy value onto a supported theme. */
export function resolveTheme(value: string | null | undefined): ThemeName {
  if (value === "light") return "light";
  // dark, punk, angels, empty, unknown → Dark
  return "dark";
}

/** Read the client-local appearance preference (no query-param preview). */
export function storedTheme(
  read: () => string | null = () =>
    typeof localStorage !== "undefined" ? localStorage.getItem("smokey-theme") : null
): ThemeName {
  return resolveTheme(read());
}

export function cycleTheme(current: string): ThemeName {
  return resolveTheme(current) === "light" ? "dark" : "light";
}

export function themeLabel(theme: string): string {
  return resolveTheme(theme) === "light" ? "Light" : "Dark";
}

export function applyTheme(theme: string, tokens?: Record<string, string>) {
  const name = resolveTheme(theme);
  const values = { ...themePresets[name], ...tokens };
  Object.entries(values).forEach(([key, value]) => document.documentElement.style.setProperty(key, value));
  document.documentElement.dataset.theme = name;
  const color = values["--bg"] ?? "#11100e";
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", color);
}
