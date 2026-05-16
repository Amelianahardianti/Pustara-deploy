/**
 * Authentication Service
 * Business logic untuk authentication
 * Independent dari provider (Firebase, Azure, etc)
 */

const UserService = require('./userService');

class AuthService {
  constructor(authProvider) {
    this.provider = authProvider; // FirebaseProvider atau AzureProvider
  }

  /**
   * Verify token dan return user info
   * @param {string} token - Auth token
   * @returns {Promise<Object>} - User info atau error
   */
  async verifyToken(token) {
    if (!token) {
      return {
        success: false,
        error: "No token provided",
        status: 400,
      };
    }

    const result = await this.provider.verifyToken(token);

    if (!result.success) {
      return {
        success: false,
        error: result.error || "Token verification failed",
        status: 401,
      };
    }

    return {
      success: true,
      user: result.data,
      status: 200,
    };
  }

  /**
   * Get user profile with role
   * @param {string} uid - User ID
   * @returns {Promise<Object>} - User profile with role
   */
  async getUserProfile(uid) {
    const result = await this.provider.getUser(uid);

    if (!result.success) {
      return {
        success: false,
        error: result.error || "Failed to get user",
        status: 404,
      };
    }

    // Fetch role from database
    const roleResult = await UserService.getUserRole(uid);
    const role = roleResult.success ? roleResult.role : 'reader';

    return {
      success: true,
      user: {
        ...result.data,
        role,
      },
      data: {
        ...result.data,
        role,
      },
      status: 200,
    };
  }

  /**
   * Logout (optional - typically frontend deletes token)
   * @param {string} uid - User ID
   * @returns {Object} - Logout result
   */
  async logout(uid) {
    // Bisa di-extend dengan revoke token, invalidate session, etc
    return {
      success: true,
      message: "Logged out successfully",
      status: 200,
    };
  }

  /**
   * Sign up dengan email & password
   * @param {string} email - User email
   * @param {string} password - User password
   * @returns {Promise<Object>} - User info atau error
   */
  async signUp(email, password) {
    // Validasi input
    if (!email || !password) {
      return {
        success: false,
        error: "Email and password are required",
        status: 400,
      };
    }

    if (password.length < 6) {
      return {
        success: false,
        error: "Password must be at least 6 characters",
        status: 400,
      };
    }

    const result = await this.provider.createUser(email, password);

    if (!result.success) {
      return {
        success: false,
        error: result.error || "Sign up failed",
        status: 400,
      };
    }

    // Save user to Azure SQL Database
    const dbResult = await UserService.createUser(result.data.uid, result.data.email);

    if (!dbResult.success) {
      console.error("Warning: User created in Firebase but failed to save to database:", dbResult.error);
      // Tetap return success karena Firebase auth berhasil
      // Database sync bisa dilakukan kemudian
    }

    return {
      success: true,
      user: {
        uid: result.data.uid,
        email: result.data.email,
      },
      message: "User created successfully",
      status: 201,
    };
  }

  /**
   * Sign in dengan email & password
   * @param {string} email - User email
   * @param {string} password - User password
   * @returns {Promise<Object>} - Token & user info atau error
   */
  async signIn(email, password) {
    // Validasi input
    if (!email || !password) {
      return {
        success: false,
        error: "Email and password are required",
        status: 400,
      };
    }

    const result = await this.provider.signInWithEmailPassword(email, password);

    if (!result.success) {
      return {
        success: false,
        error: result.error || "Sign in failed",
        status: 401,
      };
    }

    // Fetch user data dari Azure SQL Database
    const uid = result.data.uid;
    const dbResult = await UserService.getUserByUid(uid);
    
    // Jika user tidak ada di database, create record untuk backward compatibility
    if (!dbResult.data && dbResult.success) {
      console.log(`⚠️ User ${uid} not found in DB, creating...`);
      const createResult = await UserService.createUser(uid, email);
      if (!createResult.success) {
        console.error(`Failed to create user in DB for ${uid}:`, createResult.error);
        // Still return success karena Firebase auth berhasil
      }
    }

    await UserService.recordLoginEvent(uid);

    return {
      success: true,
      token: result.data.idToken,
      refreshToken: result.data.refreshToken,
      user: {
        uid: result.data.uid,
        email: result.data.email,
      },
      status: 200,
    };
  }
}

module.exports = AuthService;
