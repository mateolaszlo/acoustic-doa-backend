import { Router } from 'express';
import { sendError, handleUnexpectedRouteError } from '../utils/http_errors.js';

export function createAuthRoutes(authService, authMiddleware) {
  const router = Router();
  const { authenticateJWT } = authMiddleware;

  /**
   * POST /api/v1/auth/register
   * Public registration (new accounts are granted 'viewer' role by default)
   */
  router.post('/register', (req, res) => {
    const { username, email, password } = req.body || {};

    try {
      const user = authService.registerUser(username, email, password, 'viewer');
      const token = authService.generateToken(user);
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
   * Authenticate user with username/email and password, issuing a signed JWT
   */
  router.post('/login', (req, res) => {
    const { username, password } = req.body || {};

    try {
      const result = authService.loginUser(username, password);
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
