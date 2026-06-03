-- Add interest tags to user profiles.
-- Stored as a JSON array string e.g. '["Tech","Design","Coffee"]'.
-- Nullable: existing rows keep NULL which the app treats as an empty array.
ALTER TABLE user_profile ADD COLUMN tags TEXT;
