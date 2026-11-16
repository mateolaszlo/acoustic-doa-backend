import { Router } from 'express';
import { sendError, parsePositiveIntId, handleUnexpectedRouteError } from '../utils/http_errors.js';

export function createUserRoutes(authService, authMiddleware) {
  const router = Router();

  // Protect all user management endpoints: Requires valid Admin JWT
  router.use(...authMiddleware.requireAdmin);

  /**
   * GET /api/v1/users
   * List all registered users (admin only)
   */
  router.get('/', (_req, res) => {
    try {
      const users = authService.listUsers();
      return res.status(200).json({ users });
    } catch (err) {
      return handleUnexpectedRouteError(res, err, 'Users:List', 'USER_LIST_FAILED');
    }
  });

  /**
   * PATCH /api/v1/users/:id/role
   * Promote or demote user role (admin only)
   */
  router.patch('/:id/role', (req, res) => {
    const userId = parsePositiveIntId(req.params.id);
    if (userId === null) {
      return sendError(res, 400, 'INVALID_USER_ID', 'User ID must be a positive integer');
    }

    const { role } = req.body || {};
    try {
      const updatedUser = authService.updateUserRole(userId, role);
      return res.status(200).json({
        message: `Role for user '${updatedUser.username}' successfully updated to '${updatedUser.role}'`,
        user: updatedUser,
      });
    } catch (err) {
      return sendError(res, 400, 'ROLE_UPDATE_FAILED', err.message);
    }
  });

  /**
   * DELETE /api/v1/users/:id
   * Revoke/delete a user account (admin only)
   */
  router.delete('/:id', (req, res) => {
    const userId = parsePositiveIntId(req.params.id);
    if (userId === null) {
      return sendError(res, 400, 'INVALID_USER_ID', 'User ID must be a positive integer');
    }

    try {
      const result = authService.deleteUser(userId);
      return res.status(200).json(result);
    } catch (err) {
      return sendError(res, 400, 'DELETE_USER_FAILED', err.message);
    }
  });

  return router;
}
