/**
 * Authentication & Role-Based Access Control (RBAC) Middleware
 * Supports both HttpOnly cookie sessions (`acoustic_session`) and `Authorization: Bearer <token>`.
 */

import { parseCookies } from './cookie_parser.js';

export const SESSION_COOKIE_NAME = 'acoustic_session';

function extractToken(req) {
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const bearer = authHeader.slice(7).trim();
    if (bearer) return bearer;
  }

  const cookies = parseCookies(req.headers['cookie']);
  if (cookies[SESSION_COOKIE_NAME]) {
    return cookies[SESSION_COOKIE_NAME];
  }

  return null;
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
      return res.status(401).json({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authentication required. Please sign in to access this resource.',
          status: 401,
        },
      });
    }

    let user = null;
    try {
      user = resolveActiveUser(token);
    } catch (err) {
      console.error('[AuthMiddleware] Token verification error:', err);
      return res.status(401).json({
        error: {
          code: 'INVALID_TOKEN',
          message: 'Provided session token is invalid or has expired',
          status: 401,
        },
      });
    }

    if (!user) {
      return res.status(401).json({
        error: {
          code: 'INVALID_TOKEN',
          message: 'Provided session token is invalid or has expired',
          status: 401,
        },
      });
    }

    req.user = user;
    next();
  }

  function requireRole(requiredRole) {
    return (req, res, next) => {
      if (!req.user) {
        return res.status(401).json({
          error: {
            code: 'UNAUTHORIZED',
            message: 'Authentication required before permission check',
            status: 401,
          },
        });
      }

      if (req.user.role !== requiredRole) {
        return res.status(403).json({
          error: {
            code: 'FORBIDDEN',
            message: `Access denied. Action requires '${requiredRole}' role, but user has '${req.user.role}' role.`,
            status: 403,
          },
        });
      }

      next();
    };
  }

  function optionalJWT(req, _res, next) {
    const token = extractToken(req);
    if (token) {
      try {
        const user = resolveActiveUser(token);
        if (user) {
          req.user = user;
        }
      } catch (err) {
        console.warn('[AuthMiddleware] Optional JWT verification failed:', err.message);
      }
    }
    next();
  }

  return {
    authenticateJWT,
    requireRole,
    optionalJWT,
    authService,
  };
}

export default createAuthMiddleware;
