# AI unit recommendations for leads

Company owners, sales agents and team leads use the lead detail drawer to request ranked matches. Access requires both `leads.read` and `units.read`, an active catalog subscription and access to that specific lead through the existing tenant/owner scope. Platform read-only workspace sessions cannot start a paid request. The feature does not change lead stages, assignments, scores, notes or contact activity.

## Contract

- `POST /api/v1/leads/:leadId/unit-recommendations`: `{requestId,leadVersion,language:'en'|'ar',preferences:{location?,type?,minBedrooms?,minArea?,maxArea?,maxDeliveryYear?}}`. Starts a background job and returns `{id,status,preferences,result?,error?,createdAt}`. Exact request-ID retries are idempotent; changed payloads return 409. Fresh successful identical inputs can be reused for ten minutes. At most one live request per user/company; 20 paid attempts/hour/user and 100/day/company.
- `GET /api/v1/leads/:leadId/unit-recommendations`: `{run}` containing the latest request for this user/lead, or `{run:null}`. Reading never invokes Kimi.
- `GET /api/v1/leads/:leadId/unit-recommendations/:runId`: status/results for that user/lead. Every read rechecks lead visibility and permissions. Changed lead/catalog data marks results stale. Interrupted requests expire after three minutes and require an explicit new request; they are never retried automatically.

Kimi first interprets property requirements from the lead's Wants field and explicit refinements, then ranks at most 30 eligible catalog units. Only sanitized property needs and public catalog facts are sent: no lead name, email, phone, company identifiers or activity history. No tools or external actions are offered to the model. Strict output validation accepts only IDs from the shortlist. Explanations and over-budget warnings are calculated from stored facts, not invented model descriptions.

Hard filters: available, published primary units with published compounds/developers; residential/commercial segment; stated property type/location/bedroom/area/delivery constraints; known price. The lead's saved EGP budget is authoritative. The maximum recommendation price is `floor(budgetMinor*110/100)`; overages are explicitly labeled. No currency conversion, rental/resale substitution or silent constraint relaxation. With no matches, the UI asks the user to refine needs rather than recommending ineligible inventory.

Catalog prices and availability are source snapshots and require confirmation with the seller. Recommendations are suggestions for human review, not bookings or changes to the lead.

Generation requires a company account; platform workspace inspection sessions cannot start paid AI jobs.
