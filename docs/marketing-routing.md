# Company marketing and lead routing

Migration 019 adds company campaigns, ordered routing rules, real user rosters, lead attribution/assignment/contact fields and a restricted worker heartbeat. Existing/new owners receive marketing.read/manage and routing.read/manage. All company APIs retain subscription checks, forced RLS and same-company foreign keys. New business records use the existing company write lock and UUID replay ledger.

## Marketing registry

GET /api/v1/marketing supports pagination, search, registry status and archive filters; /:id returns one campaign. POST creates; /:id/update records name, source, optional active company project, registry status and exact manually recorded lifetime spend. Status is draft/active/ended and does not launch or synchronize advertising. /:id/archive archives/restores without deleting attribution history. Source cannot change after leads have been attributed.

Lead counts include retained archived leads, because acquisition history does not disappear on archival. Deal counts/value use actual signed sale contracts linked to attributed leads, excluding voids and other agreement types. They are signed sale values, not collected revenue. CPL is rounded to exact minor units from recorded spend/attributed lead count and is unknown when there are no leads. Totals cover all records matching the current filters, independent of pagination. No ad-network metrics or provider delivery is fabricated.

Lead create/update accepts campaignId. New links require marketing.read and an active, unarchived same-company campaign with the same source. Existing ended/archived links may be retained; source mismatches are rejected. The dashboard supplies actual campaign choices and links campaigns to a filtered Leads screen. Explicit null unlinks; omitted update fields preserve existing attribution.

## Routing policy

GET /api/v1/routing returns saved ordered rules and a sanitized worker heartbeat; /options returns actual active company users. POST creates, /:id/update edits and /:id/action enables/disables, reorders, archives/restores with current versions. At most 200 saved rules are supported; archived rules can be restored/reused. Rule rosters contain up to 20 distinct active company users. No people or pre-existing teams are invented.

Rules match source, segment and optional exact minimum budget. Unknown budget does not match a minimum-budget condition. First eligible matching rule wins; disabled/archived rules and unavailable users are skipped. Specific user requires one member. Round robin and named team rosters rotate their saved members. Team means the named roster explicitly defined in that rule. Weighted routing uses smooth weighted round robin with integer weights and persisted scores. Rule edits replace rosters/reset rotation atomically; rotation state does not create stale configuration versions.

POST /routing/simulate accepts source, segment and optional budgetMinor, reads actual rule/rotation state in a read-only snapshot and does not advance counters or create a lead. No match falls back to the current lead creator. The optional requestId accepted by the shared client is not a mutation replay token.

New leads with omitted ownerId use automatic routing, then fall back to their creator. Explicit owner/null overrides routing. The company form defaults to Automatic assignment and preserves explicit manual choices. Retries do not consume another turn. Assignments record actual database time and rule, plus audit/outbox/lead activity. Manual owner changes clear automatic policy and restart their assignment timestamp; historical leads retain unknown assignment/contact times rather than invented backfills.

POST /leads/:id/contact records explicit first contact with current version, channel and a 10–1000-character note. The timestamp is when the external contact was recorded; it does not send a message or call someone. It stops first-contact SLA processing. Notes/task completion do not pretend to establish contact.

## SLA worker and deployment

The dedicated routing-worker service uses the existing restricted tenant/platform credentials from api.env, never migration credentials. It checks persisted first-contact deadlines periodically (60 seconds between sweeps), takes the same company lock as interactive writes, and processes up to 100 eligible due leads per company per pass. It skips closed/archived leads and inaccessible companies/subscriptions, requires an alternate active member of the assigned rule, records a system audit/outbox/lead activity, and stops after three automatic attempts. First-contact recording or explicit manual ownership stops the automatic loop. There are no external notifications.

Worker progress writes a restricted platform heartbeat and a container health file. Company Routing shows only heartbeat freshness, not other companies' metrics. Admin System Health flags missing/stale heartbeats. Compose health checks and staging deployment wait for API and worker health together; rollback restores the prior service set. No new secrets are required. Run npm run worker:routing locally after building with the normal runtime configuration.

## Initial data

npm run db:seed:growth or node scripts/seed-growth.mjs --company-slug=your-slug in isolated maintenance ensures sample parents, adds two clearly labeled draft campaigns with zero recorded spend, and one disabled routing rule. Rosters use an actual existing owner only when one exists; otherwise configuration remains empty and disabled. Default targets are only the three named sample companies with current subscriptions. Reruns preserve edits, spend, attribution, rule activation and rotation. No fake campaign performance, users, contact events or messages are seeded.
