CREATE TABLE platform.support_tickets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),public_id text NOT NULL UNIQUE,
 seed_key text UNIQUE,company_id uuid NOT NULL REFERENCES platform.companies(id),
 subject jsonb NOT NULL,category text NOT NULL CHECK(category IN ('tech','billing','subscription','integration','feature','access')),
 priority text NOT NULL CHECK(priority IN ('urgent','high','med','low')),status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','progress','waiting','resolved','closed')),
 requester text NOT NULL CHECK(length(requester) BETWEEN 2 AND 160),assigned_to uuid REFERENCES platform.users(id),
 created_by uuid NOT NULL REFERENCES platform.users(id),sla_due timestamptz NOT NULL,resolved_at timestamptz,
 version integer NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_tickets_queue ON platform.support_tickets(status,updated_at DESC);
CREATE TABLE platform.support_entries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),ticket_id uuid NOT NULL REFERENCES platform.support_tickets(id),
 kind text NOT NULL CHECK(kind IN ('reply','internal','system')),body text NOT NULL CHECK(length(body) BETWEEN 1 AND 5000),
 actor_id uuid NOT NULL REFERENCES platform.users(id),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_entries_thread ON platform.support_entries(ticket_id,created_at,id);
CREATE TABLE platform.workspace_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),ticket_id uuid NOT NULL REFERENCES platform.support_tickets(id),
 actor_id uuid NOT NULL REFERENCES platform.users(id),reason text NOT NULL CHECK(length(reason) BETWEEN 10 AND 500),
 duration_minutes integer NOT NULL CHECK(duration_minutes IN (30,60,120)),status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','cancelled')),
 created_at timestamptz NOT NULL DEFAULT now(),cancelled_at timestamptz
);
CREATE UNIQUE INDEX workspace_requests_pending ON platform.workspace_requests(ticket_id,actor_id) WHERE status='pending';
CREATE TABLE platform.announcements (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),public_id text NOT NULL UNIQUE,seed_key text UNIQUE,
 title jsonb NOT NULL,body jsonb NOT NULL,type text NOT NULL CHECK(type IN ('maint','feature','update','billing')),
 target text NOT NULL CHECK(target IN ('all','starter','pro','business','enterprise')),
 language text NOT NULL CHECK(language IN ('both','en','ar')),published boolean NOT NULL DEFAULT false,
 starts_at timestamptz,ends_at timestamptz,created_by uuid NOT NULL REFERENCES platform.users(id),
 version integer NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(ends_at IS NULL OR starts_at IS NOT NULL AND ends_at>starts_at),CHECK(NOT published OR starts_at IS NOT NULL)
);
CREATE INDEX announcements_window ON platform.announcements(starts_at,ends_at) WHERE published;
GRANT SELECT,INSERT,UPDATE ON platform.support_tickets,platform.workspace_requests,platform.announcements TO mujez_platform;
GRANT SELECT,INSERT ON platform.support_entries TO mujez_platform;
