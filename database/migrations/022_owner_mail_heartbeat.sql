-- The original heartbeat table accepted only the lead-routing worker.
ALTER TABLE platform.worker_heartbeats DROP CONSTRAINT worker_heartbeats_key_check;
ALTER TABLE platform.worker_heartbeats ADD CONSTRAINT worker_heartbeats_key_check CHECK(key IN ('lead-routing','owner-email'));
