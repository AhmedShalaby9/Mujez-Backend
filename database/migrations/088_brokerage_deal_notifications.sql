-- The company owner and Sales Admins follow every brokerage deal: creation,
-- edits, approval and rejection. The generic tenant notification trigger skips
-- brokerage deals, so they get their own. The person who acted is not notified.
CREATE FUNCTION platform.notify_brokerage_deal_event() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 INSERT INTO tenant.notifications(company_id,user_id,event_id,kind,required_permission,title,route)
 SELECT NEW.company_id,u.id,NEW.id,NEW.kind,'leads.read',
   CASE NEW.kind
     WHEN 'brokerage.deal.created' THEN 'New deal'
     WHEN 'brokerage.deal.updated' THEN 'Deal updated'
     WHEN 'brokerage.deal.approved' THEN 'Deal approved'
     ELSE 'Deal rejected'
   END
   || CASE WHEN d.approval_status='pending' THEN ' (pending approval)' ELSE '' END
   || ' · ' || d.client_name || coalesce(' · by ' || actor.name,''),
   '/company/deals'
 FROM tenant.brokerage_deals d
 JOIN tenant.users u ON u.company_id=d.company_id
 LEFT JOIN LATERAL (
   SELECT e.actor_id,a.name FROM tenant.brokerage_deal_events e
   JOIN tenant.users a ON a.company_id=e.company_id AND a.id=e.actor_id
   WHERE e.company_id=d.company_id AND e.deal_id=d.id
   ORDER BY e.created_at DESC,e.version DESC LIMIT 1
 ) actor ON true
 WHERE d.company_id=NEW.company_id AND d.id=NEW.aggregate_id
   AND u.status='active' AND u.deleted_at IS NULL
   AND u.id IS DISTINCT FROM actor.actor_id
   AND EXISTS(
     SELECT 1 FROM tenant.roles r
     WHERE r.company_id=u.company_id AND r.key IN ('company_owner','sales_admin')
       AND (r.id=u.role_id OR EXISTS(SELECT 1 FROM tenant.user_additional_roles ar WHERE ar.company_id=u.company_id AND ar.user_id=u.id AND ar.role_id=r.id))
   )
 ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION platform.notify_brokerage_deal_event() FROM PUBLIC;
CREATE TRIGGER brokerage_deal_notification AFTER INSERT ON tenant.outbox_events FOR EACH ROW
 WHEN (NEW.aggregate_type='brokerage_deal' AND NEW.kind IN ('brokerage.deal.created','brokerage.deal.updated','brokerage.deal.approved','brokerage.deal.rejected'))
 EXECUTE FUNCTION platform.notify_brokerage_deal_event();
