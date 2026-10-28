import { Router } from 'express';

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
      return res.status(400).json({
        error: {
          code: 'REGISTRATION_FAILED',
          message: err.message,
          status: 400,
        },
      });
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
      return res.status(401).json({
        error: {
          code: 'AUTH_FAILED',
          message: err.message,
          status: 401,
        },
      });
    }
  });

  /**
   * GET /api/v1/auth/me
   * Return the active authenticated session profile
   */
  router.get('/me', authenticateJWT, (req, res) => {
    const user = authService.getUserById(req.user.id);
    if (!user) {
      return res.status(404).json({
        error: {
          code: 'USER_NOT_FOUND',
          message: 'Authenticated user no longer exists',
          status: 404,
        },
      });
    }

    return res.status(200).json({ user });
  });

  return router;
}

export default createAuthRoutes;
