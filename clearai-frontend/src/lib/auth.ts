/**
 * MSAL.js Authorization Code + PKCE setup.
 * PUBLIC_ENTRA_* vars are baked in at build time by Vite (import.meta.env).
 * If the deployed bundle shows getMsal() as a bare throw, the build ran
 * without env vars — ensure CI has PUBLIC_ENTRA_* set in repo Variables.
 *
 * The browser talks directly to APIM, attaching a USER-issued Entra
 * access token. The old SWA-managed-Functions BFF held a
 * client_credentials (app) token; that path was removed on 2026-05-07
 * along with the clearai-frontend/api/ folder.
 *
 * Why sessionStorage (not memoryStorage, not localStorage):
 *   The redirect flow REQUIRES a cache that survives a page unload.
 *   When loginRedirect() fires, the page navigates away to
 *   login.microsoftonline.com; when the response comes back, MSAL
 *   needs the original PKCE code-verifier + state + nonce to
 *   validate it. memoryStorage cannot survive the navigation, so
 *   MSAL silently no-ops loginRedirect when configured with it. We
 *   tried memoryStorage first and the page froze on click —
 *   confirmed by Microsoft's MSAL docs that redirect-flow + memory
 *   cache is unsupported. localStorage would work but persists
 *   across tabs/sessions and is XSS-readable. sessionStorage is the
 *   minimum that works for redirect flow: per-tab, cleared on tab
 *   close, still XSS-readable but lifetime is short.
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

/**
 * Lazy MSAL singleton. We deliberately do NOT construct the client
 * (or check env vars) at module-eval time — Astro's static-prerender
 * step imports this module via the React component tree on the build
 * machine, where PUBLIC_* env vars may not be set. A module-level
 * `throw` would crash the build. Defer everything to first use.
 *
 * On the browser, `ensureInitialized()` is what every other helper
 * awaits, so the env check fires exactly once on first render and
 * still surfaces a clear error to console.
 */

let _msal: PublicClientApplication | null = null;
let _apiScope: string | null = null;

function getMsal(): { client: PublicClientApplication; apiScope: string } {
  if (_msal && _apiScope) return { client: _msal, apiScope: _apiScope };

  const TENANT_ID = import.meta.env.PUBLIC_ENTRA_TENANT_ID;
  const CLIENT_ID = import.meta.env.PUBLIC_ENTRA_CLIENT_ID;
  const API_SCOPE = import.meta.env.PUBLIC_ENTRA_API_SCOPE;

  if (!TENANT_ID || !CLIENT_ID || !API_SCOPE) {
    throw new Error(
      'Missing PUBLIC_ENTRA_* env vars. Set PUBLIC_ENTRA_TENANT_ID, PUBLIC_ENTRA_CLIENT_ID, PUBLIC_ENTRA_API_SCOPE in your .env or SWA app settings.',
    );
  }

  _apiScope = API_SCOPE;
  _msal = new PublicClientApplication({
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
      // sessionStorage (not memoryStorage) — see top-of-file note.
      // Required because loginRedirect() unloads the page; the cache
      // must survive the round-trip back from login.microsoftonline.com.
      cacheLocation: 'sessionStorage',
      storeAuthStateInCookie: false,
    },
  });
  // Local narrowing — TS loses the non-null tracking through the
  // assignment, so capture into a const after both writes.
  return { client: _msal, apiScope: API_SCOPE };
}

let initPromise: Promise<void> | null = null;

/**
 * Idempotent initialiser. Runs `msal.initialize()` + processes any
 * pending redirect response exactly once per page load. All other
 * exported helpers await this so callers don't have to.
 */
export function ensureInitialized(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const { client } = getMsal();
    await client.initialize();
    await client.handleRedirectPromise();
    const accounts = client.getAllAccounts();
    if (accounts[0] && !client.getActiveAccount()) {
      client.setActiveAccount(accounts[0]);
    }
  })();
  return initPromise;
}

/**
 * Returns the active signed-in account, or the first cached one, or
 * null. Safe to call before init (returns null) and on the SSR side
 * (returns null because the client wasn't constructed).
 */
export function getActiveAccount(): AccountInfo | null {
  if (!_msal) return null;
  return _msal.getActiveAccount() ?? _msal.getAllAccounts()[0] ?? null;
}

/** Triggers the redirect flow. Page navigates away; nothing else here runs. */
export async function signIn(): Promise<void> {
  await ensureInitialized();
  const { client, apiScope } = getMsal();
  await client.loginRedirect({ scopes: [apiScope] });
}

/**
 * Sign the user out of Entra and return them to the login screen.
 *
 * Implementation notes (defensive layering, in failure-order):
 *
 * 1. Pre-clear our session-scoped MSAL cache BEFORE asking Entra to
 *    redirect. This guarantees the login card flips on the moment
 *    the user lands back on `/`, even if Entra's logout endpoint is
 *    slow or returns to us via the browser cache.
 *
 * 2. Pass `postLogoutRedirectUri` and `account` explicitly on every
 *    call. The PublicClientApplication-level default catches most
 *    cases, but some Entra tenant configurations require the URI on
 *    the request itself.
 *
 * 3. Use `onRedirectNavigate(url) => true` to confirm we WANT MSAL
 *    to perform the navigation. Returning false would short-circuit
 *    the redirect (useful for SPA-internal logout, but not what we
 *    want here — we need Entra to clear ITS server-side session too,
 *    otherwise the next sign-in is silently SSO'd back into the
 *    same account).
 *
 * 4. If MSAL throws or the redirect doesn't fire (e.g.
 *    postLogoutRedirectUri not registered as a Logout URL on the
 *    SPA app reg), fall back to a hard `window.location` reload —
 *    the cache is already cleared by step 1, so the user still
 *    lands on the login card; they just don't get an Entra-side
 *    server-session clear.
 */
export async function signOut(): Promise<void> {
  await ensureInitialized();
  const { client } = getMsal();
  const account = getActiveAccount();
  const postLogoutRedirectUri =
    typeof window !== 'undefined' ? window.location.origin : '/';

  // Clear session-storage cache eagerly so the login card flips on
  // the moment we return — independent of whether Entra's redirect
  // round-trips cleanly. clearCache() is sync; logoutRedirect navigates.
  try {
    await client.clearCache({ account: account ?? undefined });
  } catch {
    /* fall through — logoutRedirect will still try */
  }

  try {
    await client.logoutRedirect({
      account: account ?? undefined,
      postLogoutRedirectUri,
      // logoutHint = the user's login_hint claim from the id_token.
      // Without it, Entra shows a "Which account do you want to sign
      // out of?" picker (because login.microsoftonline.com may hold
      // multiple work/personal sessions for the same browser) and
      // never auto-redirects back. Passing the hint tells Entra
      // exactly which session to terminate; it skips the picker and
      // honours postLogoutRedirectUri.
      logoutHint: account?.idTokenClaims?.login_hint as string | undefined,
      // Returning true tells MSAL to proceed with the navigation to
      // Entra's logout endpoint. We want Entra to clear its
      // server-side session, not just our local cache.
      onRedirectNavigate: () => true,
    });
  } catch {
    // Defensive fallback — cache is already cleared, so a hard
    // navigation to '/' lands the user on the login card.
    if (typeof window !== 'undefined') {
      window.location.assign(postLogoutRedirectUri);
    }
  }
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
  const { client, apiScope } = getMsal();
  const account = getActiveAccount();
  if (!account) throw new Error('not signed in');
  try {
    const result = await client.acquireTokenSilent({
      account,
      scopes: [apiScope],
    });
    return result.accessToken;
  } catch (err) {
    if (err instanceof InteractionRequiredAuthError) {
      await client.acquireTokenRedirect({ scopes: [apiScope] });
      throw err;
    }
    throw err;
  }
}
