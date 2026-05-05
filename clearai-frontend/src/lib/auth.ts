/**
 * MSAL.js Authorization Code + PKCE setup.
 *
 * Replaces the old SWA-managed-Functions BFF. The browser now talks
 * directly to APIM, attaching a USER-issued Entra access token. The
 * BFF held a client_credentials (app) token; that path is gone — all
 * `clearai-frontend/api/` code is dead and will be deleted by infra
 * once this rollout verifies green in production.
 *
 * Why memoryStorage:
 *   The directive forbids localStorage to keep tokens out of the
 *   persistent Origin partition. memoryStorage means the cache lives
 *   on the JS heap of this tab only — close the tab and it's gone.
 *   sessionStorage was offered as a fallback for tab persistence; we
 *   don't need that for v1.
 *
 * Why memoryStorage instead of sessionStorage:
 *   sessionStorage survives navigations and reloads within the same
 *   tab. That's a slight UX improvement (no re-login on F5) but it
 *   also means the token sits in a place a same-origin XSS payload
 *   can read via `sessionStorage.getItem(...)`. The user explicitly
 *   asked us to default to in-memory; revisit if the broker UX is
 *   too painful.
 *
 * Single-source-of-truth lock:
 *   `ensureInitialized()` memoises a single `initPromise` so that
 *   parallel callers (SignInGate mount + the first acquireTokenSilent
 *   from api.ts) don't race on `msal.initialize()`. MSAL itself is
 *   safe to call twice but `handleRedirectPromise()` MUST be invoked
 *   exactly once per page load — the second call returns null and
 *   loses the auth response from the URL fragment.
 */
import {
  PublicClientApplication,
  type AccountInfo,
  InteractionRequiredAuthError,
} from '@azure/msal-browser';

const TENANT_ID = import.meta.env.PUBLIC_ENTRA_TENANT_ID;
const CLIENT_ID = import.meta.env.PUBLIC_ENTRA_CLIENT_ID;
const API_SCOPE = import.meta.env.PUBLIC_ENTRA_API_SCOPE;

if (!TENANT_ID || !CLIENT_ID || !API_SCOPE) {
  throw new Error(
    'Missing PUBLIC_ENTRA_* env vars. Set PUBLIC_ENTRA_TENANT_ID, PUBLIC_ENTRA_CLIENT_ID, PUBLIC_ENTRA_API_SCOPE in your .env or SWA app settings.',
  );
}

export const msal = new PublicClientApplication({
  auth: {
    clientId: CLIENT_ID,
    authority: `https://login.microsoftonline.com/${TENANT_ID}`,
    // Redirect URIs are pinned per environment in the ClearAI SPA DEV
    // app reg. The directive lists localhost:4321/5173 and the two
    // deployed origins; window.location.origin matches whichever one
    // the user is on.
    redirectUri:
      typeof window !== 'undefined'
        ? `${window.location.origin}/auth/callback`
        : '',
    postLogoutRedirectUri:
      typeof window !== 'undefined' ? window.location.origin : '',
    // After /auth/callback, MSAL navigates back to the URL the user
    // was on when signIn() was called. Removes the need for custom
    // redirect logic in callback.astro.
    navigateToLoginRequestUrl: true,
  },
  cache: {
    cacheLocation: 'memoryStorage',
    storeAuthStateInCookie: false,
  },
});

let initPromise: Promise<void> | null = null;

/**
 * Idempotent initialiser. Runs `msal.initialize()` + processes any
 * pending redirect response exactly once per page load. All other
 * exported helpers await this so callers don't have to.
 */
export function ensureInitialized(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    await msal.initialize();
    await msal.handleRedirectPromise();
    const accounts = msal.getAllAccounts();
    if (accounts[0] && !msal.getActiveAccount()) {
      msal.setActiveAccount(accounts[0]);
    }
  })();
  return initPromise;
}

/** Returns the active signed-in account, or the first cached one, or null. */
export function getActiveAccount(): AccountInfo | null {
  return msal.getActiveAccount() ?? msal.getAllAccounts()[0] ?? null;
}

/** Triggers the redirect flow. Page navigates away; nothing else here runs. */
export async function signIn(): Promise<void> {
  await ensureInitialized();
  await msal.loginRedirect({ scopes: [API_SCOPE] });
}

/** Logs the user out via Entra and returns to postLogoutRedirectUri. */
export async function signOut(): Promise<void> {
  await ensureInitialized();
  const account = getActiveAccount();
  await msal.logoutRedirect({ account: account ?? undefined });
}

/**
 * Returns a fresh access token for the API scope. Tries the silent
 * cache path first (cached or refreshed via the iframe trick); falls
 * back to a full redirect when MSAL says interaction is required
 * (e.g. token expired AND refresh token expired AND user closed the
 * tab between calls). The redirect itself navigates away, so the
 * `throw err` after `acquireTokenRedirect` is mostly for type-safety
 * — the page is gone before the throw resolves.
 */
export async function getAccessToken(): Promise<string> {
  await ensureInitialized();
  const account = getActiveAccount();
  if (!account) throw new Error('not signed in');
  try {
    const result = await msal.acquireTokenSilent({
      account,
      scopes: [API_SCOPE],
    });
    return result.accessToken;
  } catch (err) {
    if (err instanceof InteractionRequiredAuthError) {
      await msal.acquireTokenRedirect({ scopes: [API_SCOPE] });
      throw err;
    }
    throw err;
  }
}
