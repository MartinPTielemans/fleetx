/** Light, dark, or following the system, remembered per browser; T3's default palettes either way. */
import { useEffect, useState } from "react";

export type ThemeChoice = "system" | "light" | "dark";
const KEY = "t3-fleet:theme";

const media = window.matchMedia("(prefers-color-scheme: dark)");

export function applyTheme(choice: ThemeChoice) {
  const dark = choice === "dark" || (choice === "system" && media.matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.classList.toggle("light", !dark);
}

export function storedTheme(): ThemeChoice {
  const value = window.localStorage.getItem(KEY);
  return value === "light" || value === "dark" ? value : "system";
}

export function useTheme() {
  const [choice, setChoice] = useState<ThemeChoice>(storedTheme);
  useEffect(() => {
    applyTheme(choice);
    window.localStorage.setItem(KEY, choice);
    if (choice !== "system") return;
    const follow = () => applyTheme("system");
    media.addEventListener("change", follow);
    return () => media.removeEventListener("change", follow);
  }, [choice]);
  return [choice, setChoice] as const;
}
