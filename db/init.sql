-- This script initializes the database schema for the platform.
-- It is designed to be idempotent and can be run multiple times safely.

-- Ensure extensions are enabled (for UUID generation)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Table for managing experiments
CREATE TABLE IF NOT EXISTS experiments (
    experiment_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    password_hash VARCHAR(255),
    presentation_order VARCHAR(50) NOT NULL DEFAULT 'random' CHECK (presentation_order IN ('sequential', 'random'))
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
CREATE TABLE IF NOT EXISTS sessions (
    session_id VARCHAR(255) PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    experiment_id UUID REFERENCES experiments(experiment_id) ON DELETE SET NULL,
    device_id VARCHAR(255),
    start_time TIMESTAMPTZ NOT NULL,
    end_time TIMESTAMPTZ,
    session_type VARCHAR(50),
    clock_offset_info JSONB,
    link_status VARCHAR(50) NOT NULL DEFAULT 'pending',
    event_correction_status VARCHAR(50) NOT NULL DEFAULT 'pending'
);

-- Table for managing reusable calibration stimuli
CREATE TABLE IF NOT EXISTS calibration_items (
    item_id BIGSERIAL PRIMARY KEY,
    file_name VARCHAR(255) NOT NULL UNIQUE,
    item_type VARCHAR(50) NOT NULL,
    description TEXT,
    object_id VARCHAR(512)
);

-- Table for managing stimuli associated with an experiment
CREATE TABLE IF NOT EXISTS experiment_stimuli (
    stimulus_id BIGSERIAL PRIMARY KEY,
    experiment_id UUID NOT NULL REFERENCES experiments(experiment_id) ON DELETE CASCADE,
    file_name VARCHAR(255) NOT NULL,
    stimulus_type VARCHAR(50) NOT NULL,
    category VARCHAR(100),
    gender VARCHAR(50),
    item_name VARCHAR(255),
    brand_name VARCHAR(255),
    trial_type VARCHAR(255),
    description TEXT,
    object_id VARCHAR(512),
    UNIQUE (experiment_id, file_name)
);

-- Table for event markers recorded during a session
CREATE TABLE IF NOT EXISTS session_events (
    event_id BIGSERIAL PRIMARY KEY,
    session_id VARCHAR(255) NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    stimulus_id BIGINT REFERENCES experiment_stimuli(stimulus_id) ON DELETE SET NULL, 
    calibration_item_id BIGINT REFERENCES calibration_items(item_id) ON DELETE SET NULL,
    onset DOUBLE PRECISION NOT NULL,
    duration DOUBLE PRECISION NOT NULL,
    trial_type VARCHAR(255),
    description TEXT,
    value VARCHAR(255),
    onset_corrected_us BIGINT,
    CONSTRAINT chk_event_stimulus_link CHECK (stimulus_id IS NULL OR calibration_item_id IS NULL)
);

-- Table for metadata of raw data objects stored in MinIO
CREATE TABLE IF NOT EXISTS raw_data_objects (
    object_id VARCHAR(512) PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    device_id VARCHAR(255) NOT NULL,
    session_id VARCHAR(255) REFERENCES sessions(session_id) ON DELETE SET NULL,
    start_time TIMESTAMPTZ,
    end_time TIMESTAMPTZ,
    timestamp_start_ms BIGINT NOT NULL,
    timestamp_end_ms BIGINT NOT NULL,
    sampling_rate DOUBLE PRECISION NOT NULL,
    lsb_to_volts DOUBLE PRECISION NOT NULL
);

ALTER TABLE raw_data_objects
    ADD COLUMN IF NOT EXISTS sampling_rate DOUBLE PRECISION DEFAULT 0,
    ADD COLUMN IF NOT EXISTS lsb_to_volts DOUBLE PRECISION DEFAULT 0;

ALTER TABLE raw_data_objects
    ALTER COLUMN sampling_rate SET NOT NULL,
    ALTER COLUMN lsb_to_volts SET NOT NULL;

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
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
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

-- パフォーマンス向上のため、クエリで頻繁に使用されるカラムにインデックスを追加します。
CREATE INDEX IF NOT EXISTS idx_participants_experiment ON experiment_participants (experiment_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_experiment ON sessions (experiment_id);
CREATE INDEX IF NOT EXISTS idx_stimuli_experiment ON experiment_stimuli (experiment_id);
CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events (session_id);
CREATE INDEX IF NOT EXISTS idx_session_events_stimulus ON session_events (stimulus_id);
CREATE INDEX IF NOT EXISTS idx_raw_data_user_id_start_time_ms ON raw_data_objects (user_id, timestamp_start_ms DESC);
CREATE INDEX IF NOT EXISTS idx_raw_data_objects_session_id ON raw_data_objects (session_id);
CREATE INDEX IF NOT EXISTS idx_session_links_object ON session_object_links (object_id);
CREATE INDEX IF NOT EXISTS idx_images_user ON images (user_id);
CREATE INDEX IF NOT EXISTS idx_images_session ON images (session_id);
CREATE INDEX IF NOT EXISTS idx_audio_clips_user ON audio_clips (user_id);
CREATE INDEX IF NOT EXISTS idx_audio_clips_session ON audio_clips (session_id);
CREATE INDEX IF NOT EXISTS idx_export_tasks_experiment ON export_tasks (experiment_id);
