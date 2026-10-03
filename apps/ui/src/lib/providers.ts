/**
 * The one place that knows how provider logins and upstreams are shaped in
 * Api.ts. Views list whatever this returns, per provider instance, and never
 * name a provider themselves.
 *
 * Today the contract carries only Claude's login (`claude: ClaudeAuth`); it is
 * becoming one `ProviderAuth` per T3 provider instance. When it does, only
 * `providerLogins` changes.
 */
import type { ClaudeAuth } from "@fleetx/core/Api";

export type LoginStatus = "authenticated" | "unauthenticated" | "unknown";

export interface ProviderLogin {
  /** The T3 provider instance, to match against UiProvider.instanceId. */
  readonly instanceId: string;
  readonly status: LoginStatus;
  /** How it is signed in ("setup-token", "oauth", "api-key", …), when known. */
  readonly method: string | null;
  readonly detail: string;
}

export function providerLogins(source: { readonly claude: ClaudeAuth | null }): ReadonlyArray<ProviderLogin> {
  const claude = source.claude;
  if (claude === null) return [];
  return [
    {
      instanceId: "claudeAgent",
      status: claude.loggedIn === null ? "unknown" : claude.loggedIn ? "authenticated" : "unauthenticated",
      method: claude.method,
      detail: claude.detail,
    },
  ];
}

/** What people call a provider instance; T3's ids, as the CLI prints them. */
export const instanceLabel = (instanceId: string) => (instanceId === "claudeAgent" ? "claude" : instanceId);

const UPSTREAM_NAMES: Readonly<Record<string, string>> = { openai: "OpenAI" };

/** An upstream as reported ("anthropic", "openai", or any other), for display. */
export const upstreamLabel = (upstream: string) =>
  UPSTREAM_NAMES[upstream] ?? (upstream === "" ? "unknown" : upstream.charAt(0).toUpperCase() + upstream.slice(1));

export const statusText: Readonly<Record<LoginStatus, string>> = {
  authenticated: "signed in",
  unauthenticated: "signed out",
  unknown: "login unknown",
};
