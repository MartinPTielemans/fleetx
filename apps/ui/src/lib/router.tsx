/** Eight views, one path each; the server answers every path with the app. */
import { useEffect, useState, type MouseEvent } from "react";

export const VIEWS = ["environments", "findings", "proposals", "alerts", "skills", "mcp", "models", "config"] as const;
export type View = (typeof VIEWS)[number];

const parse = (): { view: View; rest: string } => {
  const [, first = "", ...rest] = window.location.pathname.split("/");
  const view = (VIEWS as ReadonlyArray<string>).includes(first) ? (first as View) : "environments";
  return { view, rest: decodeURIComponent(rest.join("/")) };
};

const listeners = new Set<() => void>();
window.addEventListener("popstate", () => listeners.forEach((l) => l()));

export function navigate(path: string) {
  if (path === window.location.pathname) return;
  window.history.pushState(null, "", path);
  listeners.forEach((l) => l());
}

export function useRoute() {
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const update = () => setRoute(parse());
    listeners.add(update);
    return () => {
      listeners.delete(update);
    };
  }, []);
  return route;
}

/** onClick for an <a href>: navigate in place unless the user wants a new tab. */
export function follow(event: MouseEvent<HTMLAnchorElement>) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
  event.preventDefault();
  navigate(event.currentTarget.getAttribute("href") ?? "/");
}
