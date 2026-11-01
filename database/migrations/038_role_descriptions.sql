ALTER TABLE platform.roles ADD COLUMN description jsonb NOT NULL DEFAULT '{}';
UPDATE platform.roles SET description=CASE key
 WHEN 'super_admin' THEN '{"en":"Full platform administration","ar":"إدارة المنصة بالكامل"}'::jsonb
 WHEN 'platform_admin' THEN '{"en":"Company and platform operations","ar":"إدارة الشركات وعمليات المنصة"}'::jsonb
 WHEN 'support_admin' THEN '{"en":"Company support and workspace access","ar":"دعم الشركات والوصول لمساحات العمل"}'::jsonb
 WHEN 'billing_admin' THEN '{"en":"Invoices and payments","ar":"الفواتير والمدفوعات"}'::jsonb ELSE '{}'::jsonb END WHERE system AND key<>'super_admin';
