import { type CxOptions, cx } from "class-variance-authority";
import { extendTailwindMerge } from "tailwind-merge";

// As in T3 Code: register the dense text sizes so cn() treats them as sizes.
const twMerge = extendTailwindMerge({ extend: { theme: { text: ["2xs", "3xs"] } } });

export function cn(...inputs: CxOptions) {
  return twMerge(cx(inputs));
}

/** "12s ago", "4m ago", "3h ago", "2d ago". */
export function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** "2026-10-03 14:02", local time. */
export function stamp(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "0.0.46-nightly.20261003.2623" → "0.0.46 nightly 10-03", as the CLI prints it. */
export function shortT3(version: string): string {
  const m = /^(\d+\.\d+\.\d+)-(nightly|preview)\.\d{4}(\d{2})(\d{2})\.\d+$/.exec(version);
  return m ? `${m[1]} ${m[2]} ${m[3]}-${m[4]}` : version;
}

export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}
