/**
 * What every view shares: the session, the latest check, the jobs, and the
 * live event stream. On connecting, the server first sends where things
 * stand (the latest status, a newer failed check, every job), so a reload or
 * reconnect needs nothing else. A "check" event replaces the status in place,
 * "check-failed" keeps it and says why the next one did not come, "job"
 * updates a job; any other event (the relay's "state", "pull", "hub") is
 * handed to whoever listens for it, and after a gap each listener runs once,
 * since some may have been missed.
 *
 * A hidden tab closes its stream after a while, so the server stops checking
 * for nobody, and opens it again when it is shown.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  ApiError,
  api,
  decodeCheckFailedEvent,
  decodeJobEvent,
  decodeStatusEvent,
  isUnauthorized,
  type UiJobT,
  type UiSession,
  type UiStatus,
} from "./api";
import { finished, JobBook } from "./jobs";

/** "paused": closed while the tab is hidden; "stale": this page's token is from an earlier run. */
export type Connection = "connecting" | "live" | "lost" | "paused" | "stale";

const RELAY_EVENTS = ["state", "pull", "hub"];

/** How long a hidden tab keeps its stream open. */
const HIDDEN_GRACE_MS = 30_000;

interface Store {
  readonly session: UiSession | null;
  readonly sessionError: unknown;
  readonly status: UiStatus | null;
  readonly statusError: unknown;
  /** A check the user asked for is running. */
  readonly checking: boolean;
  readonly connection: Connection;
  readonly now: number;
  /** Jobs the server knows, oldest first. */
  readonly jobs: ReadonlyArray<UiJobT>;
  /** Jobs a dialog in this tab is showing; the tray leaves them out. */
  readonly watched: ReadonlySet<string>;
  readonly recheck: () => Promise<void>;
  readonly subscribe: (type: string, listener: (data: string) => void) => () => void;
  /** Start a job and settle with it, rejected with its error if it failed; `started` hears its id first. */
  readonly runJob: (
    start: () => Promise<UiJobT>,
    started?: (id: string) => void,
  ) => Promise<UiJobT>;
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
  const [jobs, setJobs] = useState<ReadonlyMap<string, UiJobT>>(new Map());
  const [watched, setWatched] = useState<ReadonlySet<string>>(new Set());
  const listeners = useRef(new Map<string, Set<(data: string) => void>>());
  const [book] = useState(() => new JobBook(setJobs));
  const updateJob = useCallback((job: UiJobT) => book.update(job), [book]);

  useEffect(() => {
    api.session().then(setSession, setSessionError);
    api.status().then((s) => {
      setStatus(s);
      setStatusError(null);
    }, setStatusError);
    const tick = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(tick);
  }, []);

  useEffect(() => {
    let source: EventSource | null = null;
    let retry: number | undefined;
    let hiding: number | undefined;
    let stopped = false;
    let opened = false;
    const dispatch = (type: string, data: string) => {
      for (const listener of listeners.current.get(type) ?? []) listener(data);
    };
    const close = () => {
      source?.close();
      source = null;
    };
    const open = () => {
      if (stopped || source !== null) return;
      window.clearTimeout(retry);
      const current = new EventSource(api.eventsUrl());
      source = current;
      current.onopen = () => {
        setConnection("live");
        // The snapshot brings status and jobs; anything else from the gap is fetched again.
        if (opened) for (const type of RELAY_EVENTS) dispatch(type, "");
        opened = true;
      };
      current.onerror = () => {
        close();
        // A restarted t3-fleet ui does not know this page's token: say so instead of retrying forever.
        api.session().then(
          () => {
            setConnection("lost");
            retry = window.setTimeout(open, 3000);
          },
          (error: unknown) => {
            if (isUnauthorized(error)) {
              stopped = true;
              setConnection("stale");
            } else {
              setConnection("lost");
              retry = window.setTimeout(open, 3000);
            }
          },
        );
      };
      current.addEventListener("check", (event) => {
        try {
          setStatus(decodeStatusEvent("/api/events", (event as MessageEvent<string>).data));
          setStatusError(null);
        } catch (error) {
          setStatusError(error);
        }
        dispatch("check", (event as MessageEvent<string>).data);
      });
      current.addEventListener("check-failed", (event) => {
        try {
          setStatusError(
            new ApiError(
              500,
              decodeCheckFailedEvent("/api/events", (event as MessageEvent<string>).data).message,
            ),
          );
        } catch (error) {
          setStatusError(error);
        }
      });
      current.addEventListener("job", (event) => {
        try {
          updateJob(decodeJobEvent("/api/events", (event as MessageEvent<string>).data));
        } catch {
          // A job this page cannot read stays out of the tray; the next event replaces it.
        }
      });
      for (const type of RELAY_EVENTS)
        current.addEventListener(type, (event) =>
          dispatch(type, (event as MessageEvent<string>).data),
        );
    };
    const visibility = () => {
      if (document.visibilityState === "visible") {
        window.clearTimeout(hiding);
        if (source === null && !stopped) {
          setConnection("connecting");
          open();
        }
      } else {
        hiding = window.setTimeout(() => {
          if (source === null) return;
          close();
          window.clearTimeout(retry);
          setConnection("paused");
        }, HIDDEN_GRACE_MS);
      }
    };
    open();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      stopped = true;
      window.clearTimeout(retry);
      window.clearTimeout(hiding);
      document.removeEventListener("visibilitychange", visibility);
      close();
    };
  }, [updateJob]);

  // Leaving the page does not stop a job, but it does lose sight of it.
  const busy = [...jobs.values()].some((j) => !finished(j));
  useEffect(() => {
    if (!busy) return;
    const guard = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [busy]);

  const subscribe = useCallback((type: string, listener: (data: string) => void) => {
    const set = listeners.current.get(type) ?? new Set();
    set.add(listener);
    listeners.current.set(type, set);
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

  const runJob = useCallback(
    async (start: () => Promise<UiJobT>, started?: (id: string) => void) => {
      const job = await start();
      setWatched((w) => new Set(w).add(job.id));
      started?.(job.id);
      const done = await book.settled(job);
      if (done.state === "failed") throw new Error(done.error ?? "it failed");
      return done;
    },
    [book],
  );

  const jobList = useMemo(
    () => [...jobs.values()].sort((a, b) => a.startedAt - b.startedAt),
    [jobs],
  );
  const value = useMemo(
    () => ({
      session,
      sessionError,
      status,
      statusError,
      checking,
      connection,
      now,
      jobs: jobList,
      watched,
      recheck,
      subscribe,
      runJob,
    }),
    [
      session,
      sessionError,
      status,
      statusError,
      checking,
      connection,
      now,
      jobList,
      watched,
      recheck,
      subscribe,
      runJob,
    ],
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

/**
 * Something a button starts: whether it runs, how it ended, and a reset for
 * when its dialog closes. A result from before a reset is dropped.
 */
export function useAction<A extends ReadonlyArray<unknown>, T>(run: (...args: A) => Promise<T>) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<T | null>(null);
  const latest = useRef(run);
  latest.current = run;
  const generation = useRef(0);
  const start = useCallback(async (...args: A) => {
    const mine = ++generation.current;
    setRunning(true);
    setError(null);
    try {
      const value = await latest.current(...args);
      if (mine === generation.current) setResult(value);
      return value;
    } catch (e) {
      if (mine === generation.current) setError(e);
      return null;
    } finally {
      if (mine === generation.current) setRunning(false);
    }
  }, []);
  const reset = useCallback(() => {
    generation.current++;
    setRunning(false);
    setError(null);
    setResult(null);
  }, []);
  return { running, error, result, start, reset };
}
