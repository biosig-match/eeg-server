-- Create custom types for clarity
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'device_type') THEN
        CREATE TYPE device_type AS ENUM ('esp32', 'muse2', 'other');
    END IF;
END$$;

-- Table for managing experiments
CREATE TABLE IF NOT EXISTS experiments (
    experiment_id UUID PRIMARY KEY,
    participant_id VARCHAR(255) NOT NULL,
    device_id VARCHAR(255) NOT NULL,
    start_time TIMESTAMPTZ NOT NULL,
    end_time TIMESTAMPTZ,
    metadata JSONB -- Contains sampling_rate, channel_names, task_name etc.
);

-- Table for event markers from CSV
CREATE TABLE IF NOT EXISTS experiment_events (
    id SERIAL PRIMARY KEY,
    experiment_id UUID NOT NULL REFERENCES experiments(experiment_id) ON DELETE CASCADE,
    onset DOUBLE PRECISION NOT NULL, -- in seconds from experiment start
    duration DOUBLE PRECISION NOT NULL,
    description TEXT,
    stimulus_file VARCHAR(255)
);

-- TimescaleDB hypertable for raw EEG data
CREATE TABLE IF NOT EXISTS eeg_raw_data (
    "timestamp" TIMESTAMPTZ NOT NULL,
    device_id VARCHAR(255) NOT NULL,
    experiment_id UUID REFERENCES experiments(experiment_id), -- Nullable, Foreign Key
    eeg_values SMALLINT[] NOT NULL,
    impedance_values SMALLINT[],
    trigger_value INT
);
SELECT create_hypertable('eeg_raw_data', 'timestamp', if_not_exists => TRUE);

-- TimescaleDB hypertable for raw IMU data
CREATE TABLE IF NOT EXISTS imu_raw_data (
    "timestamp" TIMESTAMPTZ NOT NULL,
    device_id VARCHAR(255) NOT NULL,
    experiment_id UUID REFERENCES experiments(experiment_id), -- Nullable, Foreign Key
    accel_values DOUBLE PRECISION[],
    gyro_values DOUBLE PRECISION[]
);
SELECT create_hypertable('imu_raw_data', 'timestamp', if_not_exists => TRUE);

-- Table for media files (images, audio)
CREATE TABLE IF NOT EXISTS media_files (
    id SERIAL PRIMARY KEY,
    "timestamp" TIMESTAMPTZ NOT NULL,
    device_id VARCHAR(255) NOT NULL,
    epoch_id BIGINT,
    experiment_id UUID REFERENCES experiments(experiment_id), -- Nullable
    image_data BYTEA,
    audio_data BYTEA,
    metadata JSONB
);

-- Add indexes for performance
CREATE INDEX IF NOT EXISTS idx_eeg_exp ON eeg_raw_data (experiment_id, "timestamp");
CREATE INDEX IF NOT EXISTS idx_imu_exp ON imu_raw_data (experiment_id, "timestamp");
CREATE INDEX IF NOT EXISTS idx_media_exp ON media_files (experiment_id, "timestamp");

