-- Team performance counts immutable calls/conversions by actor and Cairo period.
CREATE INDEX cold_call_activity_performance ON tenant.cold_call_activities(company_id,actor_id,created_at) WHERE kind IN ('call','converted');
