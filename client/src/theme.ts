/**
 * Appearance is Light + Dark only.
 * Obsolete persisted values (punk, angels, anything else) resolve to Dark.
 */

export type ThemeName = "light" | "dark";

export const THEME_NAMES = ["light", "dark"] as const satisfies readonly ThemeName[];

export const themePresets: Record<ThemeName, Record<string, string>> = {
  /* Light: warm bone + smoked copper — same whiskey-cellar brand, lit up.
     accent-2 is a deeper amber than Dark so small gold text keeps contrast. */
  light: {
    "--bg": "#e9e3d7",
    "--surface": "#f7f2ea",
    "--surface-2": "#e1d9c9",
    "--text": "#201c16",
    "--muted": "#6b6353",
    "--line": "#cdc3b0",
    "--accent": "#9a5a30",
    "--accent-2": "#7a5015"
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

/**
 * Accessible name for the compact theme control — describes the action it
 * will perform (switch to the opposite theme), not the current theme.
 */
export function themeToggleLabel(current: string): string {
  return resolveTheme(current) === "light"
    ? "Switch to Dark theme"
    : "Switch to Light theme";
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
