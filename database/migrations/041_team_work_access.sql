-- Expose only account lifecycle within the current tenant, never credentials.
CREATE VIEW platform.team_employee_status WITH(security_barrier=true) AS
 SELECT company_id,user_id,status FROM platform.company_employee_accounts
 WHERE company_id=nullif(current_setting('app.company_id',true),'')::uuid;
GRANT SELECT ON platform.team_employee_status TO mujez_tenant;
