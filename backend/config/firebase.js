/**
 * Firebase Admin SDK Initialization
 * Centralized Firebase configuration
 * 
 * Supports both:
 * 1. Environment variables (Azure App Service / Cloud deployment) - PRIMARY
 * 2. Local JSON file (Development) - FALLBACK
 */

const admin = require("firebase-admin");

/**
 * Initialize Firebase Admin SDK with credentials from env vars or local file
 */
function initializeFirebase() {
  let serviceAccount;

  // ── 1. Try environment variables FIRST (Cloud deployment) ──
  if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    serviceAccount = {
      type: "service_account",
      project_id: process.env.FIREBASE_PROJECT_ID,
      private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID || "key-id",
      private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
      client_id: process.env.FIREBASE_CLIENT_ID || "client-id",
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
      auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
      client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL || "",
    };
    console.log("✅ Firebase: Loading credentials from environment variables (Cloud Mode)");
  } 
  // ── 2. Fallback to local JSON file (Development) ──
  else {
    try {
      serviceAccount = require("../pustara-kw-firebase-adminsdk-fbsvc-e6e1ebe356.json");
      console.log("✅ Firebase: Loading credentials from local JSON file (Development Mode)");
    } catch (error) {
      console.error("❌ Firebase: Unable to load service account credentials");
      console.error("   Missing both:");
      console.error("   • Environment variables: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY");
      console.error("   • Local file: pustara-kw-firebase-adminsdk-fbsvc-e6e1ebe356.json");
      console.error("");
      console.error("   For Azure deployment, set these secrets in Key Vault:");
      console.error("   • FIREBASE_PROJECT_ID");
      console.error("   • FIREBASE_CLIENT_EMAIL");
      console.error("   • FIREBASE_PRIVATE_KEY (with literal \\n for newlines)");
      process.exit(1);
    }
  }

  // Initialize Firebase Admin SDK
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: process.env.FIREBASE_PROJECT_ID,
  });

  console.log("🔐 Firebase Admin SDK initialized successfully");
}

// Initialize on module load
initializeFirebase();

// Export Firebase admin instance
module.exports = admin;
   