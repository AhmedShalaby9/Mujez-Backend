-- Correct untouched sample names while preserving customer company names.
UPDATE platform.companies
SET name=jsonb_set(name,'{ar}',to_jsonb(replace(name->>'ar','مجاز','موچز'))),
    version=version+1,updated_at=now()
WHERE (slug,name->>'ar') IN (
 ('mujez-sample-brokerage','شركة مجاز التجريبية للوساطة'),
 ('mujez-sample-developer','شركة مجاز التجريبية للتطوير'),
 ('mujez-sample-management','شركة مجاز التجريبية للإدارة')
);
UPDATE platform.announcements
SET title=jsonb_set(title,'{ar}',to_jsonb('[تجريبي] مرحبًا بكم في موچز'::text)),
    version=version+1,updated_at=now()
WHERE seed_key='initial-welcome' AND title->>'ar'='[تجريبي] مرحبًا بكم في مجاز';
