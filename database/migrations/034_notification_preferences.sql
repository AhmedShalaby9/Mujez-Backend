CREATE TABLE platform.notification_preferences(user_id uuid PRIMARY KEY REFERENCES platform.users(id),value jsonb NOT NULL DEFAULT '{}',updated_at timestamptz NOT NULL DEFAULT now());
GRANT SELECT,INSERT,UPDATE ON platform.notification_preferences TO mujez_platform;
CREATE OR REPLACE FUNCTION platform.notify_platform_event() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE perm text; route text;
BEGIN
 SELECT CASE WHEN NEW.aggregate_type='company' THEN 'co.view' WHEN NEW.aggregate_type='subscription' THEN 'sub.manage' WHEN NEW.aggregate_type IN ('invoice','payment') THEN 'billing' WHEN NEW.aggregate_type='announcement' THEN 'ann' WHEN NEW.aggregate_type IN ('support_ticket','ticket') THEN 'support' ELSE NULL END INTO perm;
 IF perm IS NULL THEN RETURN NEW; END IF;
 route:=CASE perm WHEN 'co.view' THEN '/admin/companies' WHEN 'sub.manage' THEN '/admin/subscriptions' WHEN 'billing' THEN '/admin/billing' WHEN 'ann' THEN '/admin/announcements' ELSE '/admin/support-tickets' END;
 INSERT INTO platform.notifications(user_id,event_id,kind,required_permission,title,route)
 SELECT u.id,NEW.id,NEW.kind,perm,replace(replace(NEW.kind,'.',' · '),'_',' '),route FROM platform.users u JOIN platform.roles r ON r.id=u.role_id WHERE u.status='active' AND perm=ANY(r.permissions) AND NOT EXISTS(SELECT 1 FROM platform.notification_preferences pref WHERE pref.user_id=u.id AND pref.value @> jsonb_build_object((CASE perm WHEN 'co.view' THEN 'newco' WHEN 'support' THEN 'ticket' WHEN 'sub.manage' THEN 'expiry' WHEN 'billing' THEN 'pay' ELSE 'announcement' END)||':app',false)) ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
