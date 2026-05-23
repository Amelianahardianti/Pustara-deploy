-- =========================================
-- Pustara Database Schema for Neon PostgreSQL
-- =========================================
-- =========================================
-- USERS TABLE
-- =========================================
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    firebase_uid VARCHAR(255) UNIQUE NOT NULL,
    username VARCHAR(255) UNIQUE NOT NULL,
    display_name VARCHAR(255),
    email VARCHAR(255) UNIQUE NOT NULL,
    avatar_url TEXT,
    bio TEXT,
    preferred_genres JSONB DEFAULT '[]',
    reading_streak INT DEFAULT 0,
    total_read INT DEFAULT 0,
    status VARCHAR(50) DEFAULT 'active',
    activity_visible BOOLEAN DEFAULT true,
    public_reading_list BOOLEAN DEFAULT true,
    public_reviews BOOLEAN DEFAULT true,
    public_followers BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_users_firebase_uid ON users(firebase_uid);
CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_status ON users(status);
-- =========================================
-- BOOKS TABLE
-- =========================================
CREATE TABLE IF NOT EXISTS books (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    external_key VARCHAR(255) UNIQUE,
    isbn VARCHAR(20),
    cover_id INT,
    title VARCHAR(500) NOT NULL,
    authors JSONB DEFAULT '[]',
    genres JSONB DEFAULT '[]',
    description VARCHAR(2000),
    year INT,
    pages INT,
    language VARCHAR(50) DEFAULT 'id',
    avg_rating NUMERIC(3, 2) DEFAULT 0.00,
    rating_count INT DEFAULT 0,
    total_stock INT DEFAULT 5,
    available INT DEFAULT 5,
    is_active BOOLEAN DEFAULT true,
    cover_url TEXT,
    file_url TEXT,
    file_type VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
DO $$ BEGIN IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_books_stock_non_negative'
) THEN
ALTER TABLE books
ADD CONSTRAINT chk_books_stock_non_negative CHECK (
        total_stock >= 0
        AND available >= 0
    );
END IF;
IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_books_available_within_total'
) THEN
ALTER TABLE books
ADD CONSTRAINT chk_books_available_within_total CHECK (available <= total_stock);
END IF;
END $$;
CREATE INDEX idx_books_title ON books(title);
-- =========================================
-- FOLLOWS TABLE
-- =========================================
CREATE TABLE IF NOT EXISTS follows (
    follower_id UUID NOT NULL,
    following_id UUID NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (follower_id, following_id),
    CONSTRAINT chk_follows_different CHECK (follower_id <> following_id),
    CONSTRAINT fk_follows_follower FOREIGN KEY (follower_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_follows_following FOREIGN KEY (following_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_follows_follower ON follows(follower_id);
CREATE INDEX idx_follows_following ON follows(following_id);
-- =========================================
-- LOANS TABLE
-- =========================================
CREATE TABLE IF NOT EXISTS loans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    book_id UUID NOT NULL,
    borrowed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    due_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP + INTERVAL '7 days',
    due_date TIMESTAMP,
    returned_at TIMESTAMP,
    extended BOOLEAN DEFAULT false,
    status VARCHAR(50) DEFAULT 'active' NOT NULL,
    CONSTRAINT chk_loans_status CHECK (
        status IN ('active', 'returned', 'overdue', 'extended')
    ),
    CONSTRAINT fk_loans_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_loans_book FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
);
CREATE INDEX idx_loans_user_id ON loans(user_id);
CREATE INDEX idx_loans_book_id ON loans(book_id);
CREATE INDEX idx_loans_status ON loans(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_loans_active_unique ON loans(user_id, book_id)
WHERE returned_at IS NULL;
-- =========================================
-- READING SESSIONS TABLE
-- =========================================
CREATE TABLE IF NOT EXISTS reading_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    book_id UUID NOT NULL,
    current_page INT DEFAULT 0,
    total_pages INT DEFAULT 0,
    progress_percentage NUMERIC(5, 2) DEFAULT 0,
    reading_time_minutes INT DEFAULT 0,
    status VARCHAR(50) DEFAULT 'reading' NOT NULL,
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_read_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    finished_at TIMESTAMP,
    CONSTRAINT chk_reading_sessions_status CHECK (
        status IN ('reading', 'paused', 'finished', 'active')
    ),
    CONSTRAINT fk_reading_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_reading_sessions_book FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
);
CREATE INDEX idx_reading_sessions_user_id ON reading_sessions(user_id);
CREATE INDEX idx_reading_sessions_book_id ON reading_sessions(book_id);
CREATE INDEX idx_reading_sessions_status ON reading_sessions(status);
-- =========================================
-- NOTIFICATIONS TABLE
-- =========================================
CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    type VARCHAR(50) NOT NULL,
    title VARCHAR(255),
    message TEXT,
    data JSONB,
    is_read BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_notifications_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_notifications_user_id ON notifications(user_id);
CREATE INDEX idx_notifications_is_read ON notifications(is_read);
-- =========================================
-- REVIEWS TABLE
-- =========================================
CREATE TABLE IF NOT EXISTS reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    book_id UUID NOT NULL,
    rating INT CHECK (
        rating >= 1
        AND rating <= 5
    ),
    review_text TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_reviews_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_reviews_book FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
);
CREATE INDEX idx_reviews_user_id ON reviews(user_id);
CREATE INDEX idx_reviews_book_id ON reviews(book_id);
-- =========================================
-- WISHLIST TABLE
-- =========================================
CREATE TABLE IF NOT EXISTS wishlist (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    book_id UUID NOT NULL,
    added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, book_id),
    CONSTRAINT fk_wishlist_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_wishlist_book FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
);
CREATE INDEX idx_wishlist_user_id ON wishlist(user_id);
-- =========================================
-- USERSURVEY TABLE
-- =========================================
CREATE TABLE IF NOT EXISTS "UserSurvey" (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL UNIQUE,
    gender VARCHAR(50),
    age VARCHAR(50),
    "favoriteGenre" JSONB DEFAULT '[]',
    completed BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_user_survey_user FOREIGN KEY ("userId") REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_user_survey_user_id ON "UserSurvey"("userId");
-- =========================================
-- QUEUE TABLE
-- =========================================
CREATE TABLE IF NOT EXISTS queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    book_id UUID NOT NULL,
    position INT,
    added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_queue_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_queue_book FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
);
CREATE INDEX idx_queue_user_id ON queue(user_id);
CREATE INDEX idx_queue_book_id ON queue(book_id);
-- =========================================
-- USER_BOOK_SCORES TABLE
-- =========================================
CREATE TABLE IF NOT EXISTS user_book_scores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    book_id UUID NOT NULL,
    score NUMERIC(5, 2),
    views INTEGER DEFAULT 0,
    reads INTEGER DEFAULT 0,
    likes INTEGER DEFAULT 0,
    bookmarks INTEGER DEFAULT 0,
    shares INTEGER DEFAULT 0,
    review_cnt INTEGER DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    calculated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, book_id),
    CONSTRAINT fk_user_book_scores_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_user_book_scores_book FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
);
CREATE INDEX idx_user_book_scores_user_id ON user_book_scores(user_id);