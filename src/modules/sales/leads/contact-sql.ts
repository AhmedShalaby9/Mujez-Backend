/**
 * A lead counts as contacted once an agent has logged a note, call, WhatsApp,
 * email or viewing on it since it was assigned. Used by the routing SLA.
 * Expects the leads table to be aliased as `l`.
 */
export const NOT_CONTACTED_SQL = `NOT EXISTS(SELECT 1 FROM tenant.lead_activities ca WHERE ca.company_id=l.company_id AND ca.lead_id=l.id AND ca.actor_id IS NOT NULL AND ca.kind IN ('lead.note_added','lead.call_logged','lead.whatsapp_logged','lead.email_logged','lead.viewing_logged') AND ca.created_at>=coalesce(l.assigned_at,l.created_at))`;
