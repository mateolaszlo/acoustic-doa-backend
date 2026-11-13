/**
 * Shared HTTP error formatting, validation, and safe JSON parsing helpers.
 */

export class AppError extends Error {
  /**
   * @param {number} status HTTP status code
   * @param {string} code Machine-readable error code
   * @param {string} message Human-readable diagnostic message
   */
  constructor(status, code, message) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Emits a standardized JSON error payload matching the API v1 contract.
 */
export function sendError(res, status, code, message) {
  return res.status(status).json({
    error: {
      code,
      message,
      status,
    },
  });
}

/**
 * Strictly parses a route device ID into a positive (or non-negative when allowZero) integer.
 * Rejects partial integers like '1abc' that plain parseInt would accept.
 *
 * @param {string|number} rawValue
 * @param {{ allowZero?: boolean }} [options]
 * @returns {number|null}
 */
export function parseDeviceId(rawValue, { allowZero = false } = {}) {
  const str = String(rawValue ?? '').trim();
  if (!/^-?\d+$/.test(str)) {
    return null;
  }
  const parsed = Number(str);
  const minVal = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(parsed) || parsed < minVal) {
    return null;
  }
  return parsed;
}

/**
 * Parses stored JSON safely, returning a deep-cloned fallback on syntax or type errors.
 */
export function safeJsonParse(rawJson, fallback, context = 'JSON') {
  if (typeof rawJson !== 'string' || rawJson.length === 0) {
    return JSON.parse(JSON.stringify(fallback));
  }
  try {
    return JSON.parse(rawJson);
  } catch (err) {
    console.warn(`[${context}] Failed to parse stored JSON, falling back to defaults:`, err.message);
    return JSON.parse(JSON.stringify(fallback));
  }
}

/**
 * Logs unexpected server errors and sends an HTTP error response preserving err.message for debugging.
 */
export function handleUnexpectedRouteError(res, err, context, code = 'INTERNAL_SERVER_ERROR') {
  const status = err instanceof AppError ? err.status : 500;
  const errCode = err instanceof AppError ? err.code : code;
  console.error(`[${context}] Unexpected error:`, err);
  return sendError(res, status, errCode, err?.message || 'An unexpected error occurred');
}
