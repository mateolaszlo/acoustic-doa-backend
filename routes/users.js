import { Router } from 'express';

export function createUserRoutes(authService, authMiddleware) {
  const router = Router();
  const { authenticateJWT, requireRole } = authMiddleware;

  // Protect all user management endpoints: Requires valid Admin JWT
  router.use(authenticateJWT);
  router.use(requireRole('admin'));

  /**
   * GET /api/v1/users
   * List all registered users (admin only)
   */
  router.get('/', (_req, res) => {
    try {
      const users = authService.listUsers();
      return res.status(200).json({ users });
    } catch (err) {
      return res.status(500).json({
        error: {
          code: 'USER_LIST_FAILED',
          message: err.message,
          status: 500,
        },
      });
    }
  });

  /**
   * PATCH /api/v1/users/:id/role
   * Promote or demote user role (admin only)
   */
  router.patch('/:id/role', (req, res) => {
    const userId = parseInt(req.params.id, 10);
    const { role } = req.body || {};

    if (isNaN(userId)) {
      return res.status(400).json({
        error: {
          code: 'INVALID_USER_ID',
          message: 'User ID must be an integer',
          status: 400,
        },
      });
    }

    try {
      const updatedUser = authService.updateUserRole(userId, role);
      return res.status(200).json({
        message: `Role for user '${updatedUser.username}' successfully updated to '${updatedUser.role}'`,
        user: updatedUser,
      });
    } catch (err) {
      return res.status(400).json({
        error: {
          code: 'ROLE_UPDATE_FAILED',
          message: err.message,
          status: 400,
        },
      });
    }
  });

  /**
   * DELETE /api/v1/users/:id
   * Revoke/delete a user account (admin only)
   */
  router.delete('/:id', (req, res) => {
    const userId = parseInt(req.params.id, 10);

    if (isNaN(userId)) {
      return res.status(400).json({
        error: {
          code: 'INVALID_USER_ID',
          message: 'User ID must be an integer',
          status: 400,
        },
      });
    }

    try {
      const result = authService.deleteUser(userId);
      return res.status(200).json(result);
    } catch (err) {
      return res.status(400).json({
        error: {
          code: 'DELETE_USER_FAILED',
          message: err.message,
          status: 400,
        },
      });
    }
  });

  return router;
}

export default createUserRoutes;
