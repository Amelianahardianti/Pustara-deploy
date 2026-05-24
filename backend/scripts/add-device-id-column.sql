-- =========================================
-- Migration: Add device_id to active_sessions
-- Purpose: Enable persistent device identification
-- to prevent duplicate sessions on page refresh
-- =========================================

-- PostgreSQL / Neon:
-- Uncomment below if using Neon PostgreSQL
-- ALTER TABLE active_sessions 
-- ADD COLUMN IF NOT EXISTS device_id VARCHAR(36);
-- 
-- CREATE INDEX IF NOT EXISTS idx_active_sessions_device_id 
-- ON active_sessions(device_id);

-- Azure SQL:
-- Uncomment below if using Azure SQL
-- ALTER TABLE [dbo].[active_sessions]
-- ADD device_id VARCHAR(36) NULL;
--
-- CREATE INDEX idx_active_sessions_device_id 
-- ON [dbo].[active_sessions](device_id);

-- How to run:
-- Neon: Run the PostgreSQL commands via psql or Neon dashboard
-- Azure: Run the SQL Server commands via Azure SQL Studio or SSMS
