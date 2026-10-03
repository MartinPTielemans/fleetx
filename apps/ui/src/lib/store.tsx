/**
 * What every view shares: the session, the latest check, and the live event
 * stream. A "check" event replaces the status in place; any other event (the
 * relay's "state", "pull", "hub") is handed to whoever listens for it.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { api, decodeStatusEvent, type UiSession, type UiStatus } from "./api";

export type Connection = "connecting" | "live" | "lost";

interface Store {
  readonly session: UiSession | null;
  readonly sessionError: unknown;
  readonly status: UiStatus | null;
  readonly statusError: unknown;
  /** A check the user asked for is running. */
  readonly checking: boolean;
  readonly connection: Connection;
  readonly now: number;
  readonly recheck: () => Promise<void>;
  readonly setStatus: (status: UiStatus) => void;
  readonly subscribe: (type: string, listener: (data: string) => void) => () => void;
}

const StoreContext = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<UiSession | null>(null);
  const [sessionError, setSessionError] = useState<unknown>(null);
  const [status, setStatus] = useState<UiStatus | null>(null);
  const [statusError, setStatusError] = useState<unknown>(null);
  const [checking, setChecking] = useState(false);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [now, setNow] = useState(() => Date.now());
  const listeners = useRef(new Map<string, Set<(data: string) => void>>());
  /** Adds an event type to the open EventSource; set once it exists. */
  const listenRef = useRef<(type: string) => void>(() => undefined);

  useEffect(() => {
    api.session().then(setSession, setSessionError);
    api.status().then(
      (s) => {
        setStatus(s);
        setStatusError(null);
      },
      setStatusError,
    );
    const tick = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(tick);
  }, []);

  useEffect(() => {
    let source: EventSource | null = null;
    let retry: number | undefined;
    const known = new Set<string>();
    const listen = (type: string) => {
      if (source === null || known.has(type)) return;
      known.add(type);
      source.addEventListener(type, (event) => {
        const data = (event as MessageEvent<string>).data;
        if (type === "check") {
          try {
            setStatus(decodeStatusEvent("/api/events", data));
            setStatusError(null);
          } catch (error) {
            setStatusError(error);
          }
        }
        for (const listener of listeners.current.get(type) ?? []) listener(data);
      });
    };
    const open = () => {
      source = new EventSource(api.eventsUrl());
      known.clear();
      source.onopen = () => setConnection("live");
      source.onerror = () => {
        setConnection("lost");
        source?.close();
        retry = window.setTimeout(open, 3000);
      };
      for (const type of ["check", "state", "pull", "hub", ...listeners.current.keys()]) listen(type);
    };
    open();
    listenRef.current = listen;
    return () => {
      window.clearTimeout(retry);
      source?.close();
    };
  }, []);

  const subscribe = useCallback((type: string, listener: (data: string) => void) => {
    const set = listeners.current.get(type) ?? new Set();
    set.add(listener);
    listeners.current.set(type, set);
    listenRef.current(type);
    return () => {
      set.delete(listener);
    };
  }, []);

  const recheck = useCallback(async () => {
    setChecking(true);
    try {
      setStatus(await api.status(true));
      setStatusError(null);
    } catch (error) {
      setStatusError(error);
    } finally {
      setChecking(false);
    }
  }, []);

  const value = useMemo(
    () => ({ session, sessionError, status, statusError, checking, connection, now, recheck, setStatus, subscribe }),
    [session, sessionError, status, statusError, checking, connection, now, recheck, subscribe],
  );
  return <StoreContext value={value}>{children}</StoreContext>;
}

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (store === null) throw new Error("useStore outside StoreProvider");
  return store;
}

/** Run `fn` whenever an event of `type` arrives. */
export function useEvent(type: string, fn: (data: string) => void) {
  const { subscribe } = useStore();
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => subscribe(type, (data) => latest.current(data)), [subscribe, type]);
}

/** A resource loaded on mount and on demand, with its loading and error states. */
export function useResource<T>(load: () => Promise<T>, deps: ReadonlyArray<unknown> = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++generation.current;
    setLoading(true);
    try {
      const value = await load();
      if (mine === generation.current) {
        setData(value);
        setError(null);
      }
    } catch (e) {
      if (mine === generation.current) setError(e);
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, deps);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, loading, reload, setData };
}
