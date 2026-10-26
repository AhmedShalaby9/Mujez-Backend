# Worker boundaries

Reservation expiry (every minute), routing/SLA checks, imports, outbox projection,
notifications, subscription dunning and reconciliation belong in separate worker
processes. No workers are started by this foundation. Redis is provisioned for the
queue implementation. Add durable outbox claims, retries, deduplication and dead
letter handling before wiring a projector; an activity timeline is not yet built.
