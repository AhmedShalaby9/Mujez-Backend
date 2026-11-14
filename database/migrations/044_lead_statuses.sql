-- Flat lead status list: any status can be set from any other.
DO $$ DECLARE c text; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='tenant.leads'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%stage%' LOOP
  EXECUTE format('ALTER TABLE tenant.leads DROP CONSTRAINT %I',c);
 END LOOP;
END $$;
ALTER TABLE tenant.leads ADD CONSTRAINT leads_stage_check CHECK(stage IN ('new','attempting','contacted','qualified','nurturing','unresponsive','viewing','offer','contract','won','lost','unqualified'));
