/**
 * Authentication & Role-Based Access Control (RBAC) Middleware
 */

export function createAuthMiddleware(authService) {
  function authenticateJWT(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Missing or malformed Authorization header. Expected format: Bearer <token>',
          status: 401,
        },
      });
    }

    const token = authHeader.slice(7).trim();
    const decoded = authService.verifyToken(token);

    if (!decoded) {
      return res.status(401).json({
        error: {
          code: 'INVALID_TOKEN',
          message: 'Provided JWT token is invalid or has expired',
          status: 401,
        },
      });
    }

    req.user = decoded;
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
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7).trim();
      const decoded = authService.verifyToken(token);
      if (decoded) {
        req.user = decoded;
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
