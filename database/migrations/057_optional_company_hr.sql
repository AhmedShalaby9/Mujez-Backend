-- Preserve HR access for existing customers; new companies opt in explicitly.
ALTER TABLE platform.companies ADD COLUMN hr_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE platform.companies ALTER COLUMN hr_enabled SET DEFAULT false;
