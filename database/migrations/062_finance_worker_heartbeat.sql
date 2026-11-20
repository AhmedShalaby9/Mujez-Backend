-- Register the accounting reminder worker alongside the existing worker names.
ALTER TABLE platform.worker_heartbeats DROP CONSTRAINT worker_heartbeats_key_check;
ALTER TABLE platform.worker_heartbeats ADD CONSTRAINT worker_heartbeats_key_check
 CHECK(key IN ('lead-routing','owner-email','company-finance'));
