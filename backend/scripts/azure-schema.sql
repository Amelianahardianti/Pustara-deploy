-- =========================================
-- Pustara Database Schema for Azure SQL
-- Converted from PostgreSQL (Neon) to T-SQL
-- =========================================

-- DROP existing tables (if redeploying)
-- Uncomment if needed:
/*
DROP TABLE IF EXISTS [dbo].[wishlist];
DROP TABLE IF EXISTS [dbo].[usersurvey];
DROP TABLE IF EXISTS [dbo].[user_book_scores];
DROP TABLE IF EXISTS [dbo].[reviews];
DROP TABLE IF EXISTS [dbo].[queue];
DROP TABLE IF EXISTS [dbo].[notifications];
DROP TABLE IF EXISTS [dbo].[loans];
DROP TABLE IF EXISTS [dbo].[follows];
DROP TABLE IF EXISTS [dbo].[books];
DROP TABLE IF EXISTS [dbo].[users];
*/

-- =========================================
-- USERS TABLE
-- =========================================
CREATE TABLE [dbo].[users] (
    [id] UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
    [firebase_uid] NVARCHAR(255) UNIQUE NOT NULL,
    [username] NVARCHAR(255) UNIQUE NOT NULL,
    [display_name] NVARCHAR(255),
    [email] NVARCHAR(255) UNIQUE NOT NULL,
    [avatar_url] NVARCHAR(MAX),
    [bio] NVARCHAR(MAX),
    [preferred_genres] NVARCHAR(MAX) DEFAULT '[]', -- JSON array as string
    [reading_streak] INT DEFAULT 0,
    [total_read] INT DEFAULT 0,
    [created_at] DATETIME2 DEFAULT GETDATE(),
    [updated_at] DATETIME2 DEFAULT GETDATE()
);

CREATE INDEX [idx_users_firebase_uid] ON [dbo].[users]([firebase_uid]);
CREATE INDEX [idx_users_username] ON [dbo].[users]([username]);

-- =========================================
-- BOOKS TABLE
-- =========================================
CREATE TABLE [dbo].[books] (
    [id] UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
    [external_key] NVARCHAR(255) UNIQUE,
    [cover_id] INT,
    [title] NVARCHAR(500) NOT NULL,
    [authors] NVARCHAR(MAX) DEFAULT '[]', -- JSON array as string
    [genres] NVARCHAR(MAX) DEFAULT '[]', -- JSON array as string
    [description] NVARCHAR(2000),
    [year] INT,
    [pages] INT,
    [language] NVARCHAR(50) DEFAULT 'id',
    [avg_rating] NUMERIC(3, 2) DEFAULT 0.00,
    [rating_count] INT DEFAULT 0,
    [total_stock] INT DEFAULT 5,
    [available] INT DEFAULT 5,
    [is_active] BIT DEFAULT 1,
    [file_url] NVARCHAR(MAX), -- Added for book file storage
    [file_type] NVARCHAR(50), -- Added for file type tracking
    [created_at] DATETIME2 DEFAULT GETDATE(),
    [updated_at] DATETIME2 DEFAULT GETDATE()
);

CREATE INDEX [idx_books_title] ON [dbo].[books]([title]);

-- =========================================
-- FOLLOWS TABLE (Social relationships)
-- =========================================
CREATE TABLE [dbo].[follows] (
    [follower_id] UNIQUEIDENTIFIER NOT NULL,
    [following_id] UNIQUEIDENTIFIER NOT NULL,
    [created_at] DATETIME2 DEFAULT GETDATE(),
    PRIMARY KEY ([follower_id], [following_id]),
    CONSTRAINT [chk_follows_different] CHECK ([follower_id] <> [following_id]),
    CONSTRAINT [fk_follows_follower] FOREIGN KEY ([follower_id]) REFERENCES [dbo].[users]([id]) ON DELETE NO ACTION,
    CONSTRAINT [fk_follows_following] FOREIGN KEY ([following_id]) REFERENCES [dbo].[users]([id]) ON DELETE NO ACTION
);

CREATE INDEX [idx_follows_follower] ON [dbo].[follows]([follower_id]);
CREATE INDEX [idx_follows_following] ON [dbo].[follows]([following_id]);

-- =========================================
-- LOANS TABLE (Borrowing events)
-- =========================================
CREATE TABLE [dbo].[loans] (
    [id] UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
    [user_id] UNIQUEIDENTIFIER NOT NULL,
    [book_id] UNIQUEIDENTIFIER NOT NULL,
    [borrowed_at] DATETIME2 DEFAULT GETDATE(),
    [due_at] DATETIME2 DEFAULT DATEADD(DAY, 7, GETDATE()),
    [due_date] DATETIME2,
    [returned_at] DATETIME2,
    [extended] BIT DEFAULT 0,
    [status] NVARCHAR(50) DEFAULT 'active' NOT NULL,
    CONSTRAINT [chk_loans_status] CHECK ([status] IN ('active', 'returned', 'overdue', 'extended')),
    CONSTRAINT [fk_loans_user] FOREIGN KEY ([user_id]) REFERENCES [dbo].[users]([id]) ON DELETE CASCADE,
    CONSTRAINT [fk_loans_book] FOREIGN KEY ([book_id]) REFERENCES [dbo].[books]([id]) ON DELETE CASCADE
);

CREATE INDEX [idx_loans_user_id] ON [dbo].[loans]([user_id]);
CREATE INDEX [idx_loans_book_id] ON [dbo].[loans]([book_id]);
CREATE INDEX [idx_loans_status] ON [dbo].[loans]([status]);

-- =========================================
-- NOTIFICATIONS TABLE
-- =========================================
CREATE TABLE [dbo].[notifications] (
    [id] UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
    [user_id] UNIQUEIDENTIFIER NOT NULL,
    [type] NVARCHAR(50) NOT NULL,
    [title] NVARCHAR(MAX) NOT NULL,
    [body] NVARCHAR(MAX) NOT NULL,
    [book_id] UNIQUEIDENTIFIER,
    [actor_id] UNIQUEIDENTIFIER,
    [read] BIT DEFAULT 0,
    [created_at] DATETIME2 DEFAULT GETDATE(),
    CONSTRAINT [chk_notif_type] CHECK ([type] IN ('borrow', 'due', 'like', 'follow', 'review', 'system', 'queue')),
    CONSTRAINT [fk_notif_user] FOREIGN KEY ([user_id]) REFERENCES [dbo].[users]([id]) ON DELETE NO ACTION,
    CONSTRAINT [fk_notif_book] FOREIGN KEY ([book_id]) REFERENCES [dbo].[books]([id]) ON DELETE SET NULL,
    CONSTRAINT [fk_notif_actor] FOREIGN KEY ([actor_id]) REFERENCES [dbo].[users]([id]) ON DELETE NO ACTION
);

CREATE INDEX [idx_notif_user_id] ON [dbo].[notifications]([user_id]);
CREATE INDEX [idx_notif_read] ON [dbo].[notifications]([user_id], [read]);
CREATE INDEX [idx_notif_created_at] ON [dbo].[notifications]([created_at]);

-- =========================================
-- QUEUE TABLE (Book queue/waitlist)
-- =========================================
CREATE TABLE [dbo].[queue] (
    [id] UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
    [user_id] UNIQUEIDENTIFIER UNIQUE NOT NULL,
    [book_id] UNIQUEIDENTIFIER UNIQUE NOT NULL,
    [position] INT NOT NULL,
    [joined_at] DATETIME2 DEFAULT GETDATE(),
    [notified] BIT DEFAULT 0,
    UNIQUE ([user_id], [book_id]),
    CONSTRAINT [fk_queue_user] FOREIGN KEY ([user_id]) REFERENCES [dbo].[users]([id]) ON DELETE CASCADE,
    CONSTRAINT [fk_queue_book] FOREIGN KEY ([book_id]) REFERENCES [dbo].[books]([id]) ON DELETE CASCADE
);

CREATE INDEX [idx_queue_book_id] ON [dbo].[queue]([book_id]);

-- =========================================
-- REVIEWS TABLE
-- =========================================
CREATE TABLE [dbo].[reviews] (
    [id] UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
    [user_id] UNIQUEIDENTIFIER UNIQUE NOT NULL,
    [book_id] UNIQUEIDENTIFIER UNIQUE NOT NULL,
    [rating] SMALLINT NOT NULL,
    [body] NVARCHAR(MAX),
    [likes] INT DEFAULT 0,
    [created_at] DATETIME2 DEFAULT GETDATE(),
    [updated_at] DATETIME2 DEFAULT GETDATE(),
    UNIQUE ([user_id], [book_id]),
    CONSTRAINT [chk_review_rating] CHECK ([rating] >= 1 AND [rating] <= 5),
    CONSTRAINT [fk_review_user] FOREIGN KEY ([user_id]) REFERENCES [dbo].[users]([id]) ON DELETE CASCADE,
    CONSTRAINT [fk_review_book] FOREIGN KEY ([book_id]) REFERENCES [dbo].[books]([id]) ON DELETE CASCADE
);

CREATE INDEX [idx_reviews_user_id] ON [dbo].[reviews]([user_id]);
CREATE INDEX [idx_reviews_book_id] ON [dbo].[reviews]([book_id]);

-- =========================================
-- USER BOOK SCORES TABLE (For recommendations)
-- =========================================
CREATE TABLE [dbo].[user_book_scores] (
    [user_id] UNIQUEIDENTIFIER NOT NULL,
    [book_id] UNIQUEIDENTIFIER NOT NULL,
    [score] NUMERIC(8, 3) DEFAULT 0 NOT NULL,
    [views] INT DEFAULT 0,
    [reads] INT DEFAULT 0,
    [likes] INT DEFAULT 0,
    [bookmarks] INT DEFAULT 0,
    [shares] INT DEFAULT 0,
    [review_cnt] INT DEFAULT 0,
    [updated_at] DATETIME2 DEFAULT GETDATE(),
    PRIMARY KEY ([user_id], [book_id]),
    CONSTRAINT [fk_ubs_user] FOREIGN KEY ([user_id]) REFERENCES [dbo].[users]([id]) ON DELETE CASCADE,
    CONSTRAINT [fk_ubs_book] FOREIGN KEY ([book_id]) REFERENCES [dbo].[books]([id]) ON DELETE CASCADE
);

CREATE INDEX [idx_ubs_user_id] ON [dbo].[user_book_scores]([user_id]);
CREATE INDEX [idx_ubs_book_id] ON [dbo].[user_book_scores]([book_id]);
CREATE INDEX [idx_ubs_score] ON [dbo].[user_book_scores]([score]);

-- =========================================
-- USER SURVEY TABLE (Personalization data)
-- =========================================
CREATE TABLE [dbo].[usersurvey] (
    [id] INT PRIMARY KEY IDENTITY(1,1),
    [userid] UNIQUEIDENTIFIER NOT NULL,
    [favoritegenre] NVARCHAR(100),
    [age] NVARCHAR(50),
    [gender] NVARCHAR(50),
    [createdat] DATETIME2 DEFAULT GETDATE(),
    [updatedat] DATETIME2 DEFAULT GETDATE(),
    CONSTRAINT [fk_survey_user] FOREIGN KEY ([userid]) REFERENCES [dbo].[users]([id]) ON DELETE CASCADE,
    CONSTRAINT [uq_survey_user] UNIQUE ([userid])
);

CREATE INDEX [idx_survey_userid] ON [dbo].[usersurvey]([userid]);

-- =========================================
-- WISHLIST TABLE
-- =========================================
CREATE TABLE [dbo].[wishlist] (
    [user_id] UNIQUEIDENTIFIER NOT NULL,
    [book_id] UNIQUEIDENTIFIER NOT NULL,
    [added_at] DATETIME2 DEFAULT GETDATE(),
    PRIMARY KEY ([user_id], [book_id]),
    CONSTRAINT [fk_wishlist_user] FOREIGN KEY ([user_id]) REFERENCES [dbo].[users]([id]) ON DELETE CASCADE,
    CONSTRAINT [fk_wishlist_book] FOREIGN KEY ([book_id]) REFERENCES [dbo].[books]([id]) ON DELETE CASCADE
);

-- =========================================
-- READING SESSIONS TABLE
-- =========================================
CREATE TABLE [dbo].[reading_sessions] (
    [id] UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
    [user_id] UNIQUEIDENTIFIER NOT NULL,
    [book_id] UNIQUEIDENTIFIER NOT NULL,
    [current_page] INT DEFAULT 0,
    [total_pages] INT DEFAULT 0,
    [progress_percentage] NUMERIC(5, 2) DEFAULT 0,
    [reading_time_minutes] INT DEFAULT 0,
    [status] NVARCHAR(50) DEFAULT 'reading' NOT NULL,
    [started_at] DATETIME2 DEFAULT GETDATE(),
    [last_read_at] DATETIME2 DEFAULT GETDATE(),
    [finished_at] DATETIME2,
    [created_at] DATETIME2 DEFAULT GETDATE(),
    CONSTRAINT [chk_reading_sessions_status] CHECK ([status] IN ('reading', 'paused', 'finished', 'active')),
    CONSTRAINT [fk_session_user] FOREIGN KEY ([user_id]) REFERENCES [dbo].[users]([id]) ON DELETE CASCADE,
    CONSTRAINT [fk_session_book] FOREIGN KEY ([book_id]) REFERENCES [dbo].[books]([id]) ON DELETE CASCADE
);

CREATE INDEX [idx_session_user_id] ON [dbo].[reading_sessions]([user_id]);
CREATE INDEX [idx_session_book_id] ON [dbo].[reading_sessions]([book_id]);
CREATE INDEX [idx_session_status] ON [dbo].[reading_sessions]([status]);

-- =========================================
-- Done!
-- =========================================
PRINT 'Schema created successfully!';
