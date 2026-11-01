CREATE TABLE platform.notifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES platform.users(id),
 event_id uuid NOT NULL,kind text NOT NULL,required_permission text NOT NULL,
 title text NOT NULL,route text NOT NULL,read_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id,event_id)
);
CREATE INDEX platform_notification_user ON platform.notifications(user_id,created_at DESC);
GRANT SELECT,UPDATE ON platform.notifications TO mujez_platform;
CREATE TABLE tenant.notifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES platform.companies(id),
 user_id uuid NOT NULL,event_id uuid NOT NULL,kind text NOT NULL,required_permission text NOT NULL,
 title text NOT NULL,route text NOT NULL,read_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(company_id,user_id) REFERENCES tenant.users(company_id,id),UNIQUE(company_id,user_id,event_id)
);
ALTER TABLE tenant.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant.notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY notification_company ON tenant.notifications USING(company_id=nullif(current_setting('app.company_id',true),'')::uuid) WITH CHECK(company_id=nullif(current_setting('app.company_id',true),'')::uuid);
GRANT SELECT,UPDATE ON tenant.notifications TO mujez_tenant;
CREATE FUNCTION platform.notify_platform_event() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE perm text; route text;
BEGIN
 SELECT CASE WHEN NEW.aggregate_type='company' THEN 'co.view' WHEN NEW.aggregate_type='subscription' THEN 'sub.manage' WHEN NEW.aggregate_type IN ('invoice','payment') THEN 'billing' WHEN NEW.aggregate_type='announcement' THEN 'ann' WHEN NEW.aggregate_type IN ('support_ticket','ticket') THEN 'support' ELSE NULL END INTO perm;
 IF perm IS NULL THEN RETURN NEW; END IF;
 route:=CASE perm WHEN 'co.view' THEN '/admin/companies' WHEN 'sub.manage' THEN '/admin/subscriptions' WHEN 'billing' THEN '/admin/billing' WHEN 'ann' THEN '/admin/announcements' ELSE '/admin/support-tickets' END;
 INSERT INTO platform.notifications(user_id,event_id,kind,required_permission,title,route)
 SELECT u.id,NEW.id,NEW.kind,perm,replace(replace(NEW.kind,'.',' · '),'_',' '),route FROM platform.users u JOIN platform.roles r ON r.id=u.role_id WHERE u.status='active' AND perm=ANY(r.permissions) ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION platform.notify_platform_event() FROM PUBLIC;
CREATE TRIGGER platform_event_notification AFTER INSERT ON platform.outbox_events FOR EACH ROW EXECUTE FUNCTION platform.notify_platform_event();
CREATE FUNCTION platform.notify_tenant_event() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE perm text; route text; assigned uuid;
BEGIN
 SELECT CASE NEW.aggregate_type WHEN 'lead' THEN 'leads.read' WHEN 'task' THEN 'tasks.read' WHEN 'contact' THEN 'contacts.read' WHEN 'calendar_event' THEN 'calendar.read' WHEN 'document' THEN 'documents.read' WHEN 'contract' THEN 'contracts.read' WHEN 'reservation' THEN 'reservations.read' WHEN 'commission' THEN 'commissions.read' ELSE NULL END INTO perm;
 IF perm IS NULL THEN RETURN NEW; END IF;
 IF NEW.aggregate_type='lead' THEN SELECT owner_user_id INTO assigned FROM tenant.leads WHERE company_id=NEW.company_id AND id=NEW.aggregate_id;
 ELSIF NEW.aggregate_type='task' THEN SELECT assignee_id INTO assigned FROM tenant.tasks WHERE company_id=NEW.company_id AND id=NEW.aggregate_id;
 ELSIF NEW.aggregate_type='contact' THEN SELECT owner_user_id INTO assigned FROM tenant.contacts WHERE company_id=NEW.company_id AND id=NEW.aggregate_id;
 ELSIF NEW.aggregate_type='contract' THEN SELECT owner_id INTO assigned FROM tenant.contracts WHERE company_id=NEW.company_id AND id=NEW.aggregate_id;
 END IF;
 route:=CASE NEW.aggregate_type WHEN 'lead' THEN '/company/leads' WHEN 'task' THEN '/company/tasks' WHEN 'contact' THEN '/company/contacts' WHEN 'calendar_event' THEN '/company/calendar' WHEN 'document' THEN '/company/documents' WHEN 'contract' THEN '/company/contracts' WHEN 'reservation' THEN '/company/reservations' ELSE '/company/commissions' END;
 INSERT INTO tenant.notifications(company_id,user_id,event_id,kind,required_permission,title,route)
 SELECT NEW.company_id,u.id,NEW.id,NEW.kind,perm,replace(replace(NEW.kind,'.',' · '),'_',' '),route FROM tenant.users u JOIN tenant.roles r ON r.company_id=u.company_id AND r.id=u.role_id WHERE u.company_id=NEW.company_id AND u.status='active' AND u.deleted_at IS NULL AND perm=ANY(r.permissions) AND (r.scope='company' OR (r.scope='own' AND u.id=assigned)) ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION platform.notify_tenant_event() FROM PUBLIC;
CREATE TRIGGER tenant_event_notification AFTER INSERT ON tenant.outbox_events FOR EACH ROW EXECUTE FUNCTION platform.notify_tenant_event();
