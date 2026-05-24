#!/usr/bin/env node

/**
 * Admin Setup Script
 * 
 * Usage:
 *   node setup-admin.js
 * 
 * This script allows you to:
 * - Make a user admin by email
 * - Make a user admin by username
 * - List all current admins
 * 
 * Configuration:
 * - Uses .env file for database connection
 * - Supports both Neon PostgreSQL and Azure SQL
 */

require('dotenv').config();
const readline = require('readline');
const path = require('path');

// Determine database type
const nodeEnv = (process.env.NODE_ENV || '').toLowerCase();
const isNeon = nodeEnv === 'neon' || process.env.NEON_CLOUD_MODE === 'true';

let pool = null;

// ════════════════════════════════════════════════════════════════
// Database Setup
// ════════════════════════════════════════════════════════════════

async function initializeDatabase() {
  try {
    if (isNeon) {
      // Neon PostgreSQL
      const { Pool } = require('pg');
      pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.NODE_ENV === 'dummy' ? false : { rejectUnauthorized: false },
      });
      
      const client = await pool.connect();
      await client.query('SELECT NOW()');
      client.release();
      console.log('✅ Connected to Neon PostgreSQL\n');
      return true;
    } else {
      // Azure SQL
      const sql = require('mssql');
      const azureConfig = {
        server: process.env.DB_SERVER,
        database: process.env.DB_NAME,
        authentication: {
          type: 'default',
          options: {
            userName: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
          },
        },
        options: {
          encrypt: true,
          trustServerCertificate: false,
          connectTimeout: 30000,
        },
      };
      
      pool = new sql.ConnectionPool(azureConfig);
      await pool.connect();
      console.log('✅ Connected to Azure SQL\n');
      return true;
    }
  } catch (error) {
    console.error('❌ Database connection failed:', error.message);
    return false;
  }
}

// ════════════════════════════════════════════════════════════════
// Database Operations
// ════════════════════════════════════════════════════════════════

async function makeAdminByEmail(email) {
  try {
    const query = isNeon
      ? 'UPDATE users SET role = $1 WHERE email = $2 RETURNING email, role, firebase_uid'
      : 'UPDATE users SET role = @p1 WHERE email = @p2; SELECT email, role, firebase_uid FROM users WHERE email = @p2;';
    
    const params = isNeon ? ['admin', email] : ['admin', email];
    
    let result;
    if (isNeon) {
      result = await pool.query(query, params);
    } else {
      const request = pool.request();
      request.input('p1', 'admin');
      request.input('p2', email);
      result = await request.query(query);
    }
    
    const rows = isNeon ? result.rows : result.recordset;
    if (rows.length === 0) {
      console.log(`\n❌ User not found with email: ${email}`);
      return false;
    }
    
    const user = rows[0];
    console.log(`\n✅ Successfully made admin!`);
    console.log(`   Email: ${user.email}`);
    console.log(`   UID: ${user.firebase_uid || user.uid}`);
    console.log(`   Role: ${user.role}`);
    return true;
  } catch (error) {
    console.error(`\n❌ Error: ${error.message}`);
    return false;
  }
}

async function makeAdminByUsername(username) {
  try {
    const query = isNeon
      ? 'UPDATE users SET role = $1 WHERE username = $2 RETURNING email, username, role, firebase_uid'
      : 'UPDATE users SET role = @p1 WHERE username = @p2; SELECT email, username, role, firebase_uid FROM users WHERE username = @p2;';
    
    const params = isNeon ? ['admin', username] : ['admin', username];
    
    let result;
    if (isNeon) {
      result = await pool.query(query, params);
    } else {
      const request = pool.request();
      request.input('p1', 'admin');
      request.input('p2', username);
      result = await request.query(query);
    }
    
    const rows = isNeon ? result.rows : result.recordset;
    if (rows.length === 0) {
      console.log(`\n❌ User not found with username: ${username}`);
      return false;
    }
    
    const user = rows[0];
    console.log(`\n✅ Successfully made admin!`);
    console.log(`   Email: ${user.email}`);
    console.log(`   Username: ${user.username}`);
    console.log(`   Role: ${user.role}`);
    return true;
  } catch (error) {
    console.error(`\n❌ Error: ${error.message}`);
    return false;
  }
}

async function listAdmins() {
  try {
    const query = isNeon
      ? 'SELECT email, username, role, created_at FROM users WHERE role = $1 ORDER BY created_at DESC'
      : 'SELECT email, username, role, createdAt FROM users WHERE role = @p1 ORDER BY createdAt DESC';
    
    let result;
    if (isNeon) {
      result = await pool.query(query, ['admin']);
    } else {
      const request = pool.request();
      request.input('p1', 'admin');
      result = await request.query(query);
    }
    
    const rows = isNeon ? result.rows : result.recordset;
    
    if (rows.length === 0) {
      console.log('\n⚠️  No admins found in database');
      return true;
    }
    
    console.log(`\n📊 Total Admins: ${rows.length}\n`);
    console.log('┌────────────────────────────────┬──────────────────┬──────────┐');
    console.log('│ Email                          │ Username         │ Role     │');
    console.log('├────────────────────────────────┼──────────────────┼──────────┤');
    
    rows.forEach(user => {
      const email = (user.email || '-').padEnd(30);
      const username = (user.username || '-').padEnd(16);
      const role = user.role.padEnd(8);
      console.log(`│ ${email} │ ${username} │ ${role} │`);
    });
    
    console.log('└────────────────────────────────┴──────────────────┴──────────┘');
    return true;
  } catch (error) {
    console.error(`\n❌ Error: ${error.message}`);
    return false;
  }
}

// ════════════════════════════════════════════════════════════════
// CLI Interface
// ════════════════════════════════════════════════════════════════

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(prompt) {
  return new Promise(resolve => {
    rl.question(prompt, resolve);
  });
}

async function showMenu() {
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║   Pustara Admin Setup Tool             ║');
  console.log('╚════════════════════════════════════════╝\n');
  
  console.log('What would you like to do?\n');
  console.log('  1) Make user admin by email');
  console.log('  2) Make user admin by username');
  console.log('  3) List all admins');
  console.log('  4) Exit\n');
  
  const choice = await question('Choose an option (1-4): ');
  return choice.trim();
}

async function main() {
  // Check environment
  if (!process.env.DATABASE_URL && !process.env.DB_SERVER) {
    console.error('❌ Database environment variables not configured!');
    console.error('\nPlease set up your .env file with either:');
    console.error('  - DATABASE_URL (for Neon PostgreSQL)');
    console.error('  - DB_SERVER, DB_NAME, DB_USER, DB_PASSWORD (for Azure SQL)\n');
    process.exit(1);
  }

  console.log('🔐 Pustara Admin Setup Tool\n');
  console.log(`Database: ${isNeon ? 'Neon PostgreSQL' : 'Azure SQL'}`);

  // Connect to database
  const connected = await initializeDatabase();
  if (!connected) {
    console.error('\nCannot proceed without database connection.');
    process.exit(1);
  }

  // Main loop
  let running = true;
  while (running) {
    const choice = await showMenu();

    switch (choice) {
      case '1': {
        const email = await question('\nEnter email address: ');
        if (!email.trim()) {
          console.log('❌ Email cannot be empty');
          break;
        }
        await makeAdminByEmail(email.trim());
        break;
      }

      case '2': {
        const username = await question('\nEnter username: ');
        if (!username.trim()) {
          console.log('❌ Username cannot be empty');
          break;
        }
        await makeAdminByUsername(username.trim());
        break;
      }

      case '3': {
        await listAdmins();
        break;
      }

      case '4': {
        console.log('\n👋 Goodbye!\n');
        running = false;
        break;
      }

      default:
        console.log('\n❌ Invalid choice. Please try again.');
    }
  }

  rl.close();
  
  // Close database connection
  try {
    if (isNeon) {
      await pool.end();
    } else {
      await pool.close();
    }
  } catch (e) {
    // Ignore close errors
  }
}

main().catch(error => {
  console.error('Fatal error:', error.message);
  process.exit(1);
});
