import { Router } from 'express';
import { sendError, handleUnexpectedRouteError } from '../utils/http_errors.js';
import { SESSION_COOKIE_NAME } from '../utils/auth_middleware.js';
import { createRateLimiter } from '../utils/rate_limiter.js';

function getSessionCookieOptions(req) {
  const isHttps = Boolean(req.secure || req.headers['x-forwarded-proto'] === 'https');
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: isHttps,
    path: '/',
    maxAge: 24 * 60 * 60 * 1000,
  };
}

export function createAuthRoutes(authService, authMiddleware, rateLimitOptions = {}) {
  const router = Router();
  const { authenticateJWT } = authMiddleware;

  const defaultMax = parseInt(process.env.AUTH_RATE_LIMIT_MAX || '25', 10);
  const authRateLimiter = createRateLimiter({
    windowMs: rateLimitOptions.windowMs ?? 15 * 60 * 1000,
    max: rateLimitOptions.max ?? (Number.isFinite(defaultMax) ? defaultMax : 25),
    code: 'TOO_MANY_REQUESTS',
    message: 'Too many authentication attempts. Please wait and try again later.',
  });

  /**
   * POST /api/v1/auth/register
   * Public registration (new accounts are granted 'viewer' role by default)
   */
  router.post('/register', authRateLimiter, (req, res) => {
    const { username, email, password } = req.body || {};

    try {
      const user = authService.registerUser(username, email, password, 'viewer');
      const token = authService.generateToken(user);
      res.cookie(SESSION_COOKIE_NAME, token, getSessionCookieOptions(req));
      return res.status(201).json({
        message: 'User registered successfully',
        user,
        token,
      });
    } catch (err) {
      if (err?.code?.startsWith?.('SQLITE_') && err.code !== 'SQLITE_CONSTRAINT_UNIQUE') {
        return handleUnexpectedRouteError(res, err, 'Auth:Register', 'REGISTRATION_FAILED');
      }
      return sendError(res, 400, 'REGISTRATION_FAILED', err?.message || 'Registration failed');
    }
  });

  /**
   * POST /api/v1/auth/login
   * Authenticate user with username/email and password, issuing HttpOnly cookie + JWT
   */
  router.post('/login', authRateLimiter, (req, res) => {
    const { username, password } = req.body || {};

    try {
      const result = authService.loginUser(username, password);
      res.cookie(SESSION_COOKIE_NAME, result.token, getSessionCookieOptions(req));
      return res.status(200).json({
        message: 'Login successful',
        user: result.user,
        token: result.token,
      });
    } catch (err) {
      if (err?.code?.startsWith?.('SQLITE_')) {
        return handleUnexpectedRouteError(res, err, 'Auth:Login', 'AUTH_FAILED');
      }
      return sendError(res, 401, 'AUTH_FAILED', err?.message || 'Authentication failed');
    }
  });

  /**
   * POST /api/v1/auth/logout
   * Clear session cookie
   */
  router.post('/logout', (req, res) => {
    const opts = getSessionCookieOptions(req);
    res.clearCookie(SESSION_COOKIE_NAME, {
      httpOnly: opts.httpOnly,
      sameSite: opts.sameSite,
      secure: opts.secure,
      path: opts.path,
    });
    return res.status(200).json({ message: 'Logged out successfully' });
  });

  /**
   * GET /api/v1/auth/me
   * Return the active authenticated session profile
   */
  router.get('/me', authenticateJWT, (req, res) => {
    try {
      if (!req.user || !req.user.id) {
        return sendError(res, 401, 'UNAUTHORIZED', 'Invalid session context');
      }

      const user = authService.getUserById(req.user.id);
      if (!user) {
        return sendError(res, 404, 'USER_NOT_FOUND', 'Authenticated user no longer exists');
      }

      return res.status(200).json({ user });
    } catch (err) {
      return handleUnexpectedRouteError(res, err, 'Auth:Me', 'PROFILE_FETCH_FAILED');
    }
  });

  return router;
}

export default createAuthRoutes;
