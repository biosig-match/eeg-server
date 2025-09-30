-- This script initializes the database schema for the platform.
-- It is designed to be idempotent and can be run multiple times safely.

-- Ensure extensions are enabled (for UUID generation)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Table for managing experiments
-- Represents the top-level grouping for sessions and stimuli, aligned with BIDS concepts.
CREATE TABLE IF NOT EXISTS experiments (
    experiment_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    password_hash VARCHAR(255) -- Password for joining the experiment
);

-- Table for managing participants and their roles in an experiment.
CREATE TABLE IF NOT EXISTS experiment_participants (
    experiment_id UUID NOT NULL REFERENCES experiments(experiment_id) ON DELETE CASCADE,
    user_id VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL CHECK (role IN ('owner', 'participant')),
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (experiment_id, user_id)
);

-- Table for managing measurement sessions
-- A session is a concrete instance of data recording for a given experiment.
CREATE TABLE IF NOT EXISTS sessions (
    session_id VARCHAR(255) PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    experiment_id UUID NOT NULL REFERENCES experiments(experiment_id) ON DELETE CASCADE,
    device_id VARCHAR(255),
    start_time TIMESTAMPTZ NOT NULL,
    end_time TIMESTAMPTZ,
    session_type VARCHAR(50), -- e.g., 'calibration', 'main_integrated', 'main_external'
    link_status VARCHAR(50) NOT NULL DEFAULT 'pending', -- e.g., pending, processing, completed, failed
    clock_offset_info JSONB,
    event_correction_status VARCHAR(50) NOT NULL DEFAULT 'pending'
);

-- Table for managing reusable calibration stimuli (e.g., faces, neutral images)
CREATE TABLE IF NOT EXISTS calibration_items (
    item_id BIGSERIAL PRIMARY KEY,
    file_name VARCHAR(255) NOT NULL UNIQUE, -- e.g., 'face01.jpg'
    item_type VARCHAR(50) NOT NULL, -- e.g., 'target', 'nontarget'
    description TEXT,
    object_id VARCHAR(512) -- FK to the actual file in MinIO
);


-- Table for managing stimuli associated with an experiment (The "Plan" for main tasks)
CREATE TABLE IF NOT EXISTS experiment_stimuli (
    stimulus_id BIGSERIAL PRIMARY KEY,
    experiment_id UUID NOT NULL REFERENCES experiments(experiment_id) ON DELETE CASCADE,
    file_name VARCHAR(255) NOT NULL, -- The name used in event files (e.g., 'image_895.jpg')
    stimulus_type VARCHAR(50) NOT NULL, -- e.g., 'image', 'audio'
    
    -- Additional fields for neuro-marketing context
    category VARCHAR(100), -- e.g., 'tops', 'bottoms'
    gender VARCHAR(50), -- e.g., 'mens', 'womens', 'unisex'
    item_name VARCHAR(255),
    brand_name VARCHAR(255),
    
    trial_type VARCHAR(255), -- Experimental condition (e.g., 'target', 'nontarget', 'face', 'house')
    description TEXT, -- Description of this specific stimulus
    object_id VARCHAR(512), -- FK to the actual file in MinIO
    UNIQUE (experiment_id, file_name) -- A file name must be unique within an experiment
);

-- Table for event markers recorded during a session (The "Log")
CREATE TABLE IF NOT EXISTS session_events (
    event_id BIGSERIAL PRIMARY KEY,
    session_id VARCHAR(255) NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    
    -- An event can be linked to either an experiment-specific stimulus or a generic calibration item
    stimulus_id BIGINT REFERENCES experiment_stimuli(stimulus_id) ON DELETE SET NULL, 
    calibration_item_id BIGINT REFERENCES calibration_items(item_id) ON DELETE SET NULL,
    
    onset DOUBLE PRECISION NOT NULL, -- Onset time in seconds from the session start
    duration DOUBLE PRECISION NOT NULL,
    trial_type VARCHAR(255), -- The condition recorded for this specific event instance
    description TEXT,
    value VARCHAR(255), -- Additional value recorded for this event
    onset_corrected_us BIGINT, -- Corrected onset time in microseconds based on device clock
    
    -- Ensure only one of the foreign keys is set
    CONSTRAINT chk_event_stimulus_link CHECK (stimulus_id IS NULL OR calibration_item_id IS NULL)
);


-- Table for metadata of raw data objects stored in MinIO
CREATE TABLE IF NOT EXISTS raw_data_objects (
    object_id VARCHAR(512) PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    device_id VARCHAR(255),
    start_time TIMESTAMPTZ, -- Corrected UTC start time, filled by DataLinker
    end_time TIMESTAMPTZ,   -- Corrected UTC end time, filled by DataLinker
    start_time_device BIGINT,
    end_time_device BIGINT
);

-- Junction table to link sessions and raw_data_objects
CREATE TABLE IF NOT EXISTS session_object_links (
    session_id VARCHAR(255) NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    object_id VARCHAR(512) NOT NULL REFERENCES raw_data_objects(object_id) ON DELETE CASCADE,
    PRIMARY KEY (session_id, object_id)
);

-- Table for metadata of image files stored in MinIO
CREATE TABLE IF NOT EXISTS images (
    object_id VARCHAR(512) PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    session_id VARCHAR(255),
    experiment_id UUID REFERENCES experiments(experiment_id) ON DELETE SET NULL,
    timestamp_utc TIMESTAMPTZ NOT NULL
);

-- Table for metadata of audio clip files stored in MinIO
CREATE TABLE IF NOT EXISTS audio_clips (
    object_id VARCHAR(512) PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    session_id VARCHAR(255),
    experiment_id UUID REFERENCES experiments(experiment_id) ON DELETE SET NULL,
    start_time TIMESTAMPTZ NOT NULL,
    end_time TIMESTAMPTZ NOT NULL
);

-- Table for storing ERP analysis results
CREATE TABLE IF NOT EXISTS erp_analysis_results (
    analysis_id BIGSERIAL PRIMARY KEY,
    experiment_id UUID NOT NULL REFERENCES experiments(experiment_id) ON DELETE CASCADE,
    requested_by_user_id VARCHAR(255) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'pending', -- e.g., pending, processing, completed, failed
    result_data JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

-- BIDS Exporterサービスが必要とする `export_tasks` テーブルの定義
CREATE TABLE IF NOT EXISTS export_tasks (
    task_id UUID PRIMARY KEY,
    experiment_id UUID NOT NULL REFERENCES experiments(experiment_id) ON DELETE CASCADE,
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    progress INT NOT NULL DEFAULT 0,
    result_file_path VARCHAR(512),
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ### <<< 修正点 >>> ###
-- パフォーマンス向上のため、クエリで頻繁に使用されるカラムにインデックスを追加します。
CREATE INDEX IF NOT EXISTS idx_participants_experiment ON experiment_participants (experiment_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_experiment ON sessions (experiment_id);
CREATE INDEX IF NOT EXISTS idx_stimuli_experiment ON experiment_stimuli (experiment_id);
CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events (session_id);
CREATE INDEX IF NOT EXISTS idx_session_events_stimulus ON session_events (stimulus_id);
CREATE INDEX IF NOT EXISTS idx_raw_data_user_device_time ON raw_data_objects (user_id, start_time_device DESC);
CREATE INDEX IF NOT EXISTS idx_session_links_object ON session_object_links (object_id);
CREATE INDEX IF NOT EXISTS idx_images_user ON images (user_id);
CREATE INDEX IF NOT EXISTS idx_images_session ON images (session_id);
CREATE INDEX IF NOT EXISTS idx_audio_clips_user ON audio_clips (user_id);
CREATE INDEX IF NOT EXISTS idx_audio_clips_session ON audio_clips (session_id);
CREATE INDEX IF NOT EXISTS idx_export_tasks_experiment ON export_tasks (experiment_id);

