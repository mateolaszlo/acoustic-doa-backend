/**
 * Environment configuration loader and fail-fast validator.
 */

export const PLACEHOLDER_JWT_SECRET = 'replace-with-a-long-random-secret';

export function isTestEnvironment(env = process.env) {
  return Boolean(env.VITEST || env.NODE_ENV === 'test');
}

export function isHttpsDisabled(env = process.env) {
  return env.DISABLE_HTTPS === 'true' || env.ENABLE_HTTPS === 'false';
}

export function loadEnvIfPresent() {
  if (typeof process.loadEnvFile === 'function') {
    try {
      process.loadEnvFile();
    } catch {
      // .env file may be absent if variables are provided via process environment;
      // validateEnv() below will still fail fast on any missing values.
    }
  }
}

function isValidPort(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return false;
  const n = Number(String(raw).trim());
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

export function validateEnv(env = process.env) {
  const issues = [];
  const httpsDisabled = isHttpsDisabled(env);

  if (!isValidPort(env.PORT_HTTP)) {
    issues.push('PORT_HTTP (must be an integer port 1..65535)');
  }
  if (!httpsDisabled && !isValidPort(env.PORT_HTTPS)) {
    issues.push('PORT_HTTPS (must be an integer port 1..65535 when HTTPS is enabled)');
  }
  if (!env.DATABASE_PATH || !String(env.DATABASE_PATH).trim()) {
    issues.push('DATABASE_PATH (must be a non-empty SQLite file path)');
  }

  const jwtSecret = env.JWT_SECRET ? String(env.JWT_SECRET).trim() : '';
  if (!jwtSecret || jwtSecret.length < 16 || jwtSecret === PLACEHOLDER_JWT_SECRET) {
    issues.push('JWT_SECRET (must be at least 16 characters and not the example placeholder)');
  }

  const deviceKey = env.DEFAULT_DEVICE_API_KEY ? String(env.DEFAULT_DEVICE_API_KEY).trim() : '';
  if (!deviceKey || deviceKey.length < 8) {
    issues.push('DEFAULT_DEVICE_API_KEY (must be at least 8 characters)');
  }

  for (const rolePrefix of ['DEFAULT_ADMIN', 'DEFAULT_VIEWER']) {
    const userKey = `${rolePrefix}_USER`;
    const emailKey = `${rolePrefix}_EMAIL`;
    const passKey = `${rolePrefix}_PASSWORD`;

    const u = env[userKey] ? String(env[userKey]).trim() : '';
    const e = env[emailKey] ? String(env[emailKey]).trim() : '';
    const p = env[passKey] ? String(env[passKey]) : '';

    if (u.length < 3) {
      issues.push(`${userKey} (must be at least 3 characters)`);
    }
    if (!e.includes('@')) {
      issues.push(`${emailKey} (must be a valid email address)`);
    }
    if (p.length < 8) {
      issues.push(`${passKey} (must be at least 8 characters)`);
    }
  }

  if (issues.length > 0) {
    throw new Error(`Missing or invalid required environment variables:\n  - ${issues.join('\n  - ')}`);
  }
}

export function assertRuntimeEnv() {
  loadEnvIfPresent();
  if (!isTestEnvironment()) {
    validateEnv(process.env);
  }
}
