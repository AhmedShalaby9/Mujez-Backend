ALTER TABLE platform.support_tickets ADD COLUMN first_response_at timestamptz;
UPDATE platform.support_tickets t SET first_response_at=(SELECT min(e.created_at) FROM platform.support_entries e WHERE e.ticket_id=t.id AND e.kind='reply');
