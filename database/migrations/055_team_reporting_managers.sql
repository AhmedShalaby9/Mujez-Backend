ALTER TABLE tenant.hr_employees ADD COLUMN reporting_team_id uuid;
ALTER TABLE tenant.hr_employees ADD FOREIGN KEY(company_id,reporting_team_id) REFERENCES tenant.teams(company_id,id);
ALTER TABLE tenant.leave_actions ALTER COLUMN actor_id DROP NOT NULL;
-- Invoker permissions and a checked tenant context apply to every read and write.
CREATE FUNCTION tenant.sync_team_reporting(p_company uuid,p_actor uuid DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE e record;r record;v_manager uuid;v_team uuid;v_status text;v_review uuid;v_available boolean;
BEGIN
 IF nullif(current_setting('app.company_id',true),'')::uuid IS DISTINCT FROM p_company THEN
  RAISE EXCEPTION 'Tenant context mismatch' USING ERRCODE='42501';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('sales:'||p_company::text,80425113));
 IF EXISTS(SELECT 1 FROM tenant.users u JOIN tenant.teams t ON t.company_id=u.company_id AND t.id=u.team_id LEFT JOIN tenant.hr_employees m ON m.company_id=t.company_id AND m.user_id=t.lead_user_id WHERE u.company_id=p_company AND u.deleted_at IS NULL AND t.lead_user_id IS NOT NULL AND t.lead_user_id<>u.id AND m.id IS NULL) THEN
  RAISE EXCEPTION 'Team lead requires a linked HR profile' USING ERRCODE='23514';
 END IF;
 FOR e IN
  SELECT h.id,h.manager_id,h.reporting_team_id,t.id AS team_id,t.lead_user_id,u.id AS user_id,m.id AS lead_employee
  FROM tenant.hr_employees h LEFT JOIN tenant.users u ON u.company_id=h.company_id AND u.id=h.user_id AND u.deleted_at IS NULL
  LEFT JOIN tenant.teams t ON t.company_id=u.company_id AND t.id=u.team_id
  LEFT JOIN tenant.hr_employees m ON m.company_id=t.company_id AND m.user_id=t.lead_user_id
  WHERE h.company_id=p_company ORDER BY h.id
 LOOP
  IF e.lead_employee IS NOT NULL AND e.lead_user_id<>e.user_id THEN
   v_manager:=e.lead_employee;v_team:=e.team_id;
  ELSE
   v_manager:=CASE WHEN e.reporting_team_id IS NOT NULL THEN NULL ELSE e.manager_id END;v_team:=NULL;
  END IF;
  IF e.manager_id IS DISTINCT FROM v_manager OR e.reporting_team_id IS DISTINCT FROM v_team THEN
   UPDATE tenant.hr_employees SET manager_id=v_manager,reporting_team_id=v_team,version=version+1,updated_at=now() WHERE company_id=p_company AND id=e.id;
   INSERT INTO tenant.audit_logs(company_id,actor_user_id,action,resource_type,resource_id,before,after) VALUES(p_company,p_actor,'hr.reporting_manager.synced','hr',e.id,jsonb_build_object('managerId',e.manager_id,'teamId',e.reporting_team_id),jsonb_build_object('managerId',v_manager,'teamId',v_team));
   INSERT INTO tenant.outbox_events(company_id,kind,aggregate_type,aggregate_id,payload) VALUES(p_company,'hr.reporting_manager.synced','hr',e.id,jsonb_build_object('managerId',v_manager,'teamId',v_team));
   IF e.manager_id IS DISTINCT FROM v_manager THEN
    SELECT u.id,(m.status<>'offboarded' AND u.status='active' AND u.deleted_at IS NULL) INTO v_review,v_available FROM tenant.hr_employees m LEFT JOIN tenant.users u ON u.company_id=m.company_id AND u.id=m.user_id WHERE m.company_id=p_company AND m.id=v_manager;
    FOR r IN SELECT * FROM tenant.leave_requests WHERE company_id=p_company AND employee_id=e.id AND status IN ('pending_manager','pending_hr') FOR UPDATE LOOP
     v_status:=CASE WHEN coalesce(v_available,false) THEN CASE WHEN r.manager_reviewed_by=v_review THEN 'pending_hr' ELSE 'pending_manager' END ELSE 'pending_hr' END;
     UPDATE tenant.leave_requests SET status=v_status,manager_reviewed_by=CASE WHEN manager_reviewed_by=v_review AND coalesce(v_available,false) THEN manager_reviewed_by ELSE NULL END,version=version+1,updated_at=now() WHERE company_id=p_company AND id=r.id;
     INSERT INTO tenant.leave_actions(company_id,request_id,actor_id,action,note) VALUES(p_company,r.id,p_actor,'manager_reassigned','Reporting manager updated from team membership');
     INSERT INTO tenant.audit_logs(company_id,actor_user_id,action,resource_type,resource_id,before,after) VALUES(p_company,p_actor,'leave.manager_reassigned','leave',r.id,jsonb_build_object('status',r.status),jsonb_build_object('status',v_status,'managerId',v_manager));
     INSERT INTO tenant.outbox_events(company_id,kind,aggregate_type,aggregate_id,payload) VALUES(p_company,'leave.manager_reassigned','leave',r.id,jsonb_build_object('status',v_status));
    END LOOP;
   END IF;
  END IF;
 END LOOP;
 IF EXISTS(WITH RECURSIVE chain AS (
  SELECT id,manager_id,ARRAY[id] AS path,false AS cycle FROM tenant.hr_employees WHERE company_id=p_company
  UNION ALL SELECT m.id,m.manager_id,c.path||m.id,m.id=ANY(c.path) FROM chain c JOIN tenant.hr_employees m ON m.company_id=p_company AND m.id=c.manager_id WHERE NOT c.cycle
 ) SELECT 1 FROM chain WHERE cycle) THEN
  RAISE EXCEPTION 'Team reporting relationship would create a cycle' USING ERRCODE='23514';
 END IF;
END $$;
REVOKE ALL ON FUNCTION tenant.sync_team_reporting(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant.sync_team_reporting(uuid,uuid) TO mujez_tenant;
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT id FROM platform.companies ORDER BY id LOOP
  PERFORM set_config('app.company_id',c.id::text,true);
  PERFORM tenant.sync_team_reporting(c.id,NULL);
 END LOOP;
END $$;
