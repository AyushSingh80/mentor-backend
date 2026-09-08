/**
 * Server credentials.
 *
 * This stores the bearer token for *our* backend — never an Anthropic key.
 * The Anthropic key lives on the server and must never reach the device;
 * anything bundled into an APK can be extracted from it.
 */

import * as SecureStore from 'expo-secure-store';

const TOKEN_KEY = 'server_bearer_token';
const BASE_URL_KEY = 'server_base_url';

export async function getServerToken(): Promise<string | null> {
  return SecureStore.getItemAsync(TOKEN_KEY);
}

export async function setServerToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_KEY, token.trim());
}

export async function getServerBaseUrl(): Promise<string | null> {
  return SecureStore.getItemAsync(BASE_URL_KEY);
}

/**
 * Hosts allowed to use plain http, for local development only. Everything else
 * must be https: the bearer token and scanned answer pages travel over this
 * connection, and that token is the only thing standing between a stranger on
 * the same Wi-Fi and the Anthropic bill.
 */
function isLocalHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname.endsWith('.local') ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
  );
}

export function validateServerBaseUrl(raw: string): { ok: true; url: string } | { ok: false; reason: string } {
  const trimmed = raw.trim().replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'That is not a valid URL. It should start with https://' };
  }

  if (parsed.protocol === 'https:') return { ok: true, url: trimmed };

  if (parsed.protocol === 'http:' && isLocalHost(parsed.hostname)) {
    return { ok: true, url: trimmed };
  }

  return {
    ok: false,
    reason:
      'The server URL must use https. Plain http is only allowed for localhost or a LAN address during development.',
  };
}

export async function setServerBaseUrl(url: string): Promise<void> {
  const result = validateServerBaseUrl(url);
  if (!result.ok) throw new Error(result.reason);
  await SecureStore.setItemAsync(BASE_URL_KEY, result.url);
}

export async function clearServerCredentials(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKEN_KEY);
  await SecureStore.deleteItemAsync(BASE_URL_KEY);
}
