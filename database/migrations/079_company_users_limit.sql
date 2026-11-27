-- Per-company users (seats) limit, set by the super admin independently of the
-- subscribed plan. Existing companies default to 20.
ALTER TABLE platform.companies ADD COLUMN max_users integer NOT NULL DEFAULT 20 CHECK (max_users>0 AND max_users<=100000);
