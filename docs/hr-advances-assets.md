# Salary advances and company assets

Both modules require an active company subscription and the company HR toggle. They use company RLS, transactional audit/outbox, optimistic versions and actor-bound idempotency (`requestId`). Platform inspection sessions are excluded. No real company receives demo assets or debt automatically.

## Access and API contract

Base: `/api/v1/hr-resources`, authenticated company session cookie. GET `context` supplies linked self, canRequest, canAssets, canManageAssets, canFinance and Cairo `today`. GET `options` returns current employee IDs/names/codes for HR assignment.

GET `assets` or `advances`: `view=my|company`, `page` (1+), `limit` (1–100), `search` (max120), `status` (all by default). Returns items,total,page,limit plus asset status stats or advance summary (outstandingMinor,overdueMinor,pending,awaitingPayout). Advance summaries use the filtered records across all pages. Monetary values are decimal **minor-unit strings**, EGP only.

Employees with a linked Employee role see their own requests/custody, including previous asset handovers. Company Owner and HR Manager can see company advances; HR Officer and Team Lead do not gain financial visibility. Owner and HR Officer/Manager can view company assets, and hr.manage is required for inventory/assignment changes. Managers do not inherit financial authority through reporting lines.

## Assets

POST `assets` or `assets/:id`: requestId, version (required on edit), kind (`sim_card|laptop|phone|tablet`), name, details, optional status (`available|repair|retired`). Code is generated as AST-0001 etc. Details permit brand,model,serial,imei,phoneNumber,iccid,carrier,plan,purchaseDate,warrantyUntil,notes. These are descriptive fields, not a credential store. Private HR notes/procurement dates are omitted from personal views.

GET `assets/:id` includes handover history. Prior custodians only see their own history and never the next employee's identity. POST `assets/:id/action`: requestId,version, action:

- assign: employeeId,date,condition. Available assets only, current employees, no future handovers or handovers before joining.
- return: date,condition. Must follow handover; asset becomes available and the existing handover is closed.
- acknowledge: current employee confirms their own receipt and recorded handover condition.

One open custody per asset is enforced in the database. Assigned assets cannot be retired, marked for repair or changed to another type until returned. Employee offboarding does not erase custody; the HR list flags unreturned assets of offboarded employees. Reassignment requires an explicit return. History is retained.

## Salary advances

POST `advances`: requestId,amountMinor (1–100000000000),mode (`lump_sum|monthly`),installments (1–60; lump sum requires 1),firstDue (after today within five years),reason. Only the current linked employee may submit; no impersonated employee ID is accepted. Terms are immutable after submission. Request cancellation/rejection and resubmission is used if terms must change.

GET `advances/:id` returns principal,requested terms,review note,payout,balance,repayment schedule,immutable payments/reversals and canReview. The first installment sets the monthly day; short months clamp to their last day and subsequent months return to the original day. Integer rounding remainder goes into the final installment. Payments allocate oldest first. A future or merely approved advance has no outstanding debt until actual payout is recorded.

POST `advances/:id/action`: requestId,version,action and applicable fields:

- approve/reject: Owner or HR Manager; no self-approval/rejection. Reject requires note (3–2000). Approval requires current employee and a first repayment date still in the future.
- cancel: requesting employee only, pending requests only.
- payout: date,reference. Already approved, current employee; payout date must be on/after approval and before firstDue, up to today. Marks active. Does **not** transfer money.
- repay: amountMinor,date,reference. Actual payout must exist; no overpayment, no date before payout or after today. Supports any partial or early amount. Marks paid when the full principal is repaid.
- reverse: paymentId,note (3–2000). Retains the original payment, inserts one immutable reversal and reopens the outstanding balance. Cannot reverse twice or a payment belonging to another advance.

Advances are interest-free, without fees, bank transfers or automatic payroll deductions. Overdue balance is the unpaid part of installments due before Cairo today. Offboarding does not erase outstanding balances. Every money mutation locks the company idempotency ledger and advance, rejects stale versions and rolls back if audit fails. Finance review reasons remain in the restricted finance record, not general outbox payloads.

## First setup

HR inventory starts empty: add the actual equipment, assign to employees and have employees acknowledge. Employees request actual advances; authorized HR records only actual payouts/receipts. Test data is restricted to an isolated QA company.
