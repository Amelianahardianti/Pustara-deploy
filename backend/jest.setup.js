/**
 * Jest Setup File
 * 
 * Runs before all tests - useful for global configuration
 */

// Suppress console logs during testing (optional - remove if you want to see logs)
// global.console = {
//   ...console,
//   log: jest.fn(),
//   debug: jest.fn(),
//   info: jest.fn(),
//   warn: jest.fn(),
// };

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.PORT = 3000;

// Increase timeout for database operations
jest.setTimeout(10000);
