/**
 * The one place that knows how provider logins and upstreams are shaped in
 * Api.ts. Views list whatever this returns, per provider instance, and never
 * name a provider themselves.
 */
import type { ProviderAuth } from "@t3-fleet/core/Api";

export type LoginStatus = "authenticated" | "unauthenticated" | "unknown";

export interface ProviderLogin {
  /** The T3 provider instance, to match against UiProvider.instanceId. */
  readonly instanceId: string;
  readonly status: LoginStatus;
  /** How it is signed in ("chatgpt", "apiKey", "setup-token", …), when known. */
  readonly method: string | null;
  readonly detail: string;
}

export function providerLogins(source: {
  readonly providerAuth: ReadonlyArray<ProviderAuth>;
}): ReadonlyArray<ProviderLogin> {
  return source.providerAuth
    .filter((p) => p.enabled)
    .map((p) => ({
      instanceId: p.instanceId,
      status: p.auth,
      method: p.method,
      detail: p.label === null ? p.detail : `${p.label}${p.detail === "" ? "" : ` · ${p.detail}`}`,
    }));
}

/** What people call a provider instance; T3's ids, as the CLI prints them. */
export const instanceLabel = (instanceId: string) =>
  instanceId === "claudeAgent" ? "claude" : instanceId;

const UPSTREAM_NAMES: Readonly<Record<string, string>> = { openai: "OpenAI" };

/** An upstream as reported ("anthropic", "openai", or any other), for display. */
export const upstreamLabel = (upstream: string) =>
  UPSTREAM_NAMES[upstream] ??
  (upstream === "" ? "unknown" : upstream.charAt(0).toUpperCase() + upstream.slice(1));

export const statusText: Readonly<Record<LoginStatus, string>> = {
  authenticated: "signed in",
  unauthenticated: "signed out",
  unknown: "login unknown",
};
