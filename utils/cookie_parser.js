/**
 * Dependency-free HTTP Cookie header parser for Express requests.
 */

export function parseCookies(cookieHeader) {
  const cookies = Object.create(null);
  if (!cookieHeader || typeof cookieHeader !== 'string') {
    return cookies;
  }

  const pairs = cookieHeader.split(';');
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;

    const rawName = pair.slice(0, idx).trim();
    const rawValue = pair.slice(idx + 1).trim();
    if (!rawName || rawName === '__proto__' || rawName === 'constructor' || rawName === 'prototype') {
      continue;
    }

    try {
      cookies[rawName] = decodeURIComponent(rawValue);
    } catch {
      cookies[rawName] = rawValue;
    }
  }

  return cookies;
}

export default parseCookies;
