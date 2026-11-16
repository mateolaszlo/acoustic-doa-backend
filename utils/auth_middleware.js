/**
 * Authentication & Role-Based Access Control (RBAC) Middleware
 * Supports both HttpOnly cookie sessions (`acoustic_session`) and `Authorization: Bearer <token>`.
 */

import { parseCookies } from './cookie_parser.js';
import { sendError } from './http_errors.js';

export const SESSION_COOKIE_NAME = 'acoustic_session';

function extractToken(req) {
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const bearer = authHeader.slice(7).trim();
    if (bearer) return bearer;
  }

  const cookies = parseCookies(req.headers['cookie']);
  return cookies[SESSION_COOKIE_NAME] || null;
}

export function createAuthMiddleware(authService) {
  function resolveActiveUser(token) {
    const decoded = authService.verifyToken(token);
    if (!decoded || !decoded.id) return null;

    // Re-verify live user record so deleted or demoted accounts lose access immediately
    const liveUser = authService.getUserById(decoded.id);
    if (!liveUser) return null;

    return {
      id: liveUser.id,
      username: liveUser.username,
      email: liveUser.email,
      role: liveUser.role,
    };
  }

  function authenticateJWT(req, res, next) {
    const token = extractToken(req);
    if (!token) {
      return sendError(
        res,
        401,
        'UNAUTHORIZED',
        'Authentication required. Please sign in to access this resource.'
      );
    }

    let user = null;
    try {
      user = resolveActiveUser(token);
    } catch (err) {
      console.error('[AuthMiddleware] Token verification error:', err);
    }

    if (!user) {
      return sendError(res, 401, 'INVALID_TOKEN', 'Provided session token is invalid or has expired');
    }

    req.user = user;
    next();
  }

  function requireRole(requiredRole) {
    return (req, res, next) => {
      if (!req.user) {
        return sendError(res, 401, 'UNAUTHORIZED', 'Authentication required before permission check');
      }

      if (req.user.role !== requiredRole) {
        return sendError(
          res,
          403,
          'FORBIDDEN',
          `Access denied. Action requires '${requiredRole}' role, but user has '${req.user.role}' role.`
        );
      }

      next();
    };
  }

  return {
    authenticateJWT,
    requireRole,
    requireAuth: [authenticateJWT],
    requireAdmin: [authenticateJWT, requireRole('admin')],
  };
}
