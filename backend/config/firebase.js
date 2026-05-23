/**
 * Firebase Admin SDK Initialization
 * Centralized Firebase configuration
 * Uses environment variables for cloud deployment (Azure, etc.)
 */

const admin = require("firebase-admin");

// Validate required environment variables
const requiredEnvVars = [
  "FIREBASE_PROJECT_ID",
  "FIREBASE_CLIENT_EMAIL",
  "FIREBASE_PRIVATE_KEY",
];

const missingEnvVars = requiredEnvVars.filter(
  (envVar) => !process.env[envVar]
);

if (missingEnvVars.length > 0) {
  throw new Error(
    `Missing required Firebase environment variables: ${missingEnvVars.join(", ")}`
  );
}

// Load service account credentials from environment variables
const serviceAccount = {
  projectId: process.env.FIREBASE_PROJECT_ID,
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
};

// Initialize Firebase Admin SDK
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: process.env.FIREBASE_PROJECT_ID,
});

console.log("🔐 Firebase Admin SDK initialized successfully");

// Export Firebase admin instance
module.exports = admin;
   