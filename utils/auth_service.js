import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

function resolveJwtSecret() {
  if (process.env.JWT_SECRET && process.env.JWT_SECRET.trim().length >= 16) {
    return process.env.JWT_SECRET.trim();
  }
  if (process.env.VITEST || process.env.NODE_ENV === 'test') {
    return 'acoustic-doa-test-jwt-secret-key-2026';
  }
  console.warn(
    '[SECURITY WARN] JWT_SECRET is not set (or <16 chars). Generated ephemeral runtime secret; sessions will reset on restart.'
  );
  return crypto.randomBytes(32).toString('hex');
}

export const JWT_SECRET = resolveJwtSecret();
export const JWT_EXPIRY = process.env.JWT_EXPIRY || '24h';
const BCRYPT_ROUNDS = process.env.VITEST ? 10 : 12;
const USERNAME_REGEX = /^[a-zA-Z0-9_.-]{3,32}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class AuthService {
  constructor(db) {
    this.db = db;
  }

  generateToken(payload) {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY, algorithm: 'HS256' });
  }

  verifyToken(token) {
    try {
      return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    } catch {
      return null;
    }
  }

  registerUser(username, email, password, role = 'viewer') {
    if (!username || typeof username !== 'string' || !USERNAME_REGEX.test(username.trim())) {
      throw new Error('Username must be 3-32 characters (letters, numbers, _, ., -)');
    }
    if (!email || typeof email !== 'string' || email.trim().length > 254 || !EMAIL_REGEX.test(email.trim())) {
      throw new Error('A valid email address is required');
    }
    if (!password || typeof password !== 'string' || password.length < 8 || password.length > 128) {
      throw new Error('Password must be between 8 and 128 characters long');
    }
    if (!['admin', 'viewer'].includes(role)) {
      role = 'viewer';
    }

    const cleanUsername = username.trim().toLowerCase();
    const cleanEmail = email.trim().toLowerCase();

    // Check for existing username or email
    const existing = this.db
      .prepare('SELECT id, username, email FROM users WHERE username = ? OR email = ?')
      .get(cleanUsername, cleanEmail);

    if (existing) {
      if (existing.username === cleanUsername) {
        throw new Error(`Username '${cleanUsername}' is already taken`);
      }
      throw new Error(`Email '${cleanEmail}' is already registered`);
    }

    const hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
    const now = new Date().toISOString();

    const insertStmt = this.db.prepare(`
      INSERT INTO users (username, email, password_hash, role, created_at, last_login_at)
      VALUES (?, ?, ?, ?, ?, NULL)
    `);

    const result = insertStmt.run(cleanUsername, cleanEmail, hash, role, now);
    const userId = Number(result.lastInsertRowid);

    return {
      id: userId,
      username: cleanUsername,
      email: cleanEmail,
      role,
      created_at: now,
    };
  }

  loginUser(identifier, password) {
    if (!identifier || typeof identifier !== 'string' || !password || typeof password !== 'string' || password.length > 128) {
      throw new Error('Username and password are required');
    }

    const cleanId = identifier.trim().toLowerCase();
    const user = this.db
      .prepare('SELECT id, username, email, password_hash, role FROM users WHERE username = ? OR email = ?')
      .get(cleanId, cleanId);

    if (!user) {
      throw new Error('Invalid username or password');
    }

    const match = bcrypt.compareSync(password, user.password_hash);
    if (!match) {
      throw new Error('Invalid username or password');
    }

    const now = new Date().toISOString();
    this.db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now, user.id);

    const payload = {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
    };

    const token = this.generateToken(payload);

    return {
      token,
      user: payload,
    };
  }

  getUserById(id) {
    const user = this.db
      .prepare('SELECT id, username, email, role, created_at, last_login_at FROM users WHERE id = ?')
      .get(id);
    return user || null;
  }

  listUsers() {
    return this.db
      .prepare('SELECT id, username, email, role, created_at, last_login_at FROM users ORDER BY id ASC')
      .all();
  }

  updateUserRole(userId, newRole) {
    if (!['admin', 'viewer'].includes(newRole)) {
      throw new Error("Role must be either 'admin' or 'viewer'");
    }

    const user = this.getUserById(userId);
    if (!user) {
      throw new Error(`User #${userId} not found`);
    }

    // Protect against demoting the last admin
    if (user.role === 'admin' && newRole !== 'admin') {
      const adminCount = this.db
        .prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin'")
        .get().count;
      if (adminCount <= 1) {
        throw new Error('Cannot demote the only remaining administrator');
      }
    }

    this.db.prepare('UPDATE users SET role = ? WHERE id = ?').run(newRole, userId);
    return this.getUserById(userId);
  }

  deleteUser(userId) {
    const user = this.getUserById(userId);
    if (!user) {
      throw new Error(`User #${userId} not found`);
    }

    // Protect against deleting the last admin
    if (user.role === 'admin') {
      const adminCount = this.db
        .prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin'")
        .get().count;
      if (adminCount <= 1) {
        throw new Error('Cannot delete the only remaining administrator');
      }
    }

    this.db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    return { success: true, deleted_user_id: userId };
  }
}

export default AuthService;
