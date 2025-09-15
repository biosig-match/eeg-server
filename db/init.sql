-- This script initializes the database schema for the platform.
-- It is designed to be idempotent and can be run multiple times safely.

-- Ensure extensions are enabled if needed (e.g., for UUID generation)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Table for managing experiments
-- Represents the top-level grouping for sessions, aligned with BIDS concepts.
CREATE TABLE IF NOT EXISTS experiments (
    experiment_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    description TEXT
);

-- Table for managing measurement sessions
-- A session belongs to a single experiment.
CREATE TABLE IF NOT EXISTS sessions (
    session_id VARCHAR(255) PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    experiment_id UUID NOT NULL REFERENCES experiments(experiment_id) ON DELETE CASCADE,
    device_id VARCHAR(255),
    start_time TIMESTAMPTZ NOT NULL,
    end_time TIMESTAMPTZ,
    session_type VARCHAR(50),
    link_status VARCHAR(50) NOT NULL DEFAULT 'pending' -- e.g., pending, processing, completed, failed
);

-- Table for event markers (triggers) within a session
-- Typically uploaded from a CSV file at the end of a session.
CREATE TABLE IF NOT EXISTS events (
    id BIGSERIAL PRIMARY KEY,
    session_id VARCHAR(255) NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    onset DOUBLE PRECISION NOT NULL, -- Onset time in seconds from the session start
    duration DOUBLE PRECISION NOT NULL,
    description TEXT,
    value VARCHAR(255) -- e.g., 'stimulus/left', 't-posed'
);

-- Table for metadata of raw data objects stored in MinIO
-- These are the immutable, compressed data chunks sent from the firmware.
CREATE TABLE IF NOT EXISTS raw_data_objects (
    object_id VARCHAR(512) PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    device_id VARCHAR(255),
    start_time TIMESTAMPTZ NOT NULL,
    end_time TIMESTAMPTZ NOT NULL
);

-- Junction table to link sessions and raw_data_objects
-- Manages the many-to-many relationship, as a single data object can span
-- the boundary of two or more sessions.
CREATE TABLE IF NOT EXISTS session_object_links (
    session_id VARCHAR(255) NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    object_id VARCHAR(512) NOT NULL REFERENCES raw_data_objects(object_id) ON DELETE CASCADE,
    PRIMARY KEY (session_id, object_id)
);

-- Table for metadata of image files stored in MinIO
CREATE TABLE IF NOT EXISTS images (
    object_id VARCHAR(512) PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    session_id VARCHAR(255), -- No foreign key constraint to allow asynchronous insertion
    experiment_id UUID REFERENCES experiments(experiment_id) ON DELETE SET NULL, -- Linked by DataLinker
    timestamp_utc TIMESTAMPTZ NOT NULL
);

-- Table for metadata of audio clips stored in MinIO
CREATE TABLE IF NOT EXISTS audio_clips (
    object_id VARCHAR(512) PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    session_id VARCHAR(255), -- No foreign key constraint to allow asynchronous insertion
    experiment_id UUID REFERENCES experiments(experiment_id) ON DELETE SET NULL, -- Linked by DataLinker
    start_time TIMESTAMPTZ NOT NULL,
    end_time TIMESTAMPTZ NOT NULL
);

-- Create indexes to improve query performance
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_experiment ON sessions (experiment_id);
CREATE INDEX IF NOT EXISTS idx_events_session ON events (session_id);
CREATE INDEX IF NOT EXISTS idx_raw_data_user_time ON raw_data_objects (user_id, start_time DESC);
CREATE INDEX IF NOT EXISTS idx_raw_data_time_range ON raw_data_objects USING gist (tsrange(start_time, end_time)); -- For faster time-based lookups
CREATE INDEX IF NOT EXISTS idx_session_links_object ON session_object_links (object_id);
CREATE INDEX IF NOT EXISTS idx_images_user ON images (user_id);
CREATE INDEX IF NOT EXISTS idx_images_session ON images (session_id);
CREATE INDEX IF NOT EXISTS idx_audio_clips_user ON audio_clips (user_id);
CREATE INDEX IF NOT EXISTS idx_audio_clips_session ON audio_clips (session_id);