# Company accounting implementation

Company accounting is separate from Mujez platform subscription billing and independent of the HR toggle. It requires an active subscription, an explicit finance role or the company owner, and company RLS. Sales and team leads retain personal CRM scope. No endpoint initiates a bank transfer.

## Delivery sequence

1. Settings, chart of accounts, branches, cost centres, parties, periods, roles.
2. Draft and posted journals, immutable balanced posting, reversals, account statements and closed-period protection.
3. Cashboxes/banks, numbered receipts/payments/transfers and opening journals.
4. CRM deal inbox, developer commission agreements, earned commission claims, employee payables, collection and settlement.
5. Supplier bills, approved expenses, employee cash custody/settlement, cheques and bank reconciliation.
6. Trial balance, general ledger, profit/loss, balance sheet, cash-flow reconciliation, aging, finance overview, internal reminders and exports.

Egyptian e-invoicing submission and WhatsApp delivery remain deferred. Local financial documents must not claim tax-authority acceptance. No live cash balance or historic income is invented by seeding a chart of accounts. Existing commission and HR advance records require explicit linking/reconciliation before accounting recognition.

## Contract

Base `/api/v1/accounting`, company session cookie, all writes require actor-bound `requestId`, edits/actions require `version`. Amounts are exact decimal minor-unit strings. EGP is the initial posting currency; document currency must match the configured base. Foreign currency posting and exchange-rate gains/losses are not silently inferred.

GET context/options; POST setup; GET/POST settings, accounts, dimensions, parties, periods, journals, treasuries, transactions, obligations, agreements, cheques, reconciliations; GET overview/reports/deals/reminders. Entity actions retain audit history; posted transactions are corrected by reversals in an open period. File attachments use company finance access and checked content types. Reports use posted journals only and preserve the effective dates of originals and reversals.

Accounting events must remain balanced at database and service levels. Drafts/forecasts never affect financial statements. Customer money collected for a developer is a liability, not brokerage revenue. HR salary-advance principal and employee expense custody are assets, not salary expense. Reversals cannot erase old entries, double-pay invoices, allocate more than outstanding amounts or bypass period locks.

## Access and getting started

Owners have all five finance permissions. `accountant` can read, draft and post; `finance_manager` can also approve and configure. Finance roles do not expand a salesperson's CRM scope. Sales and team leads see only their personal or current team's entitlement statements at `/company/my-finance`. Company-wide accounting is available at `/company/finance`, including when HR is disabled.

An owner or finance manager initializes Finance Settings for the financial year. Setup creates the system chart, an open period and a zero-balance cashbox. Enter real branches/cost centres, customer/developer/supplier/employee parties and bank accounts. Record verified opening balances with an explicitly balanced opening journal, then post it. No company financial transactions are automatically seeded. Configure VAT deliberately; the initial zero value is not a tax recommendation.

## Operational workflows

- Signed non-sample CRM contracts enter the finance deal inbox. Select the developer agreement and verify contract/agreement versions before booking earned claims and staff commissions. Agreement bands use the highest matching band's rate on the full deal value. Splits preserve every minor unit. Subsequent contract changes require explicit adjustment or cancellation, including refund payables and recoveries of paid staff commission.
- Receivables/payables support draft, submission, approval, posting, partial settlement and credit notes. Customer installment schedules distinguish company-held developer funds from developer-direct collections; customer funds are a liability, never brokerage income. Cancellation releases unpaid installments and creates refunds for money already collected.
- Treasury vouchers record completed external receipts, payments and internal transfers. Cheques affect cash only on clearance; bounce reversals reopen receivables. Bank statement matching supports completion and reasoned reopening; completed statements protect earlier bank postings. Physical cash cannot go negative.
- Employee custody supports partial documented expense settlement, unused-cash returns and reversal. HR advance links explicitly recognize existing HR payouts and repayments in a treasury; they do not pay an employee twice. Commission offsets and reversals update accounting and HR together. Linked HR repayments must be corrected through Finance.
- Posted journals and money movements are immutable. Corrections use dated reversal entries in an open financial period, preserving original records, actor and request history. Source-generated obligations must be adjusted through their source workflow.

## Reports and supporting documents

Reports include trial balance, account/party ledger, accrual profit and loss, balance sheet, cash-flow reconciliation, aging, commission statements, actual collections net of receipt reversals and refunds, collection targets, sales performance, expenses by cost centre and tax account balances. Date and dimension filters apply to posted data. CSV exports represent the displayed rows. Private checked attachments and internal PDF vouchers are available; PDF generation does not constitute Egyptian tax-authority submission.

The staging finance worker sends deduplicated internal due/overdue notifications to authorized finance staff. Its heartbeat is `/tmp/mujez-finance-heartbeat`; no email or WhatsApp messages are sent by this reminder worker.

## Limits

Initial accounting is EGP only. No bank API payments, statutory tax filing, ETA submission or WhatsApp provider integration is enabled. Finance roles have company-wide finance access; branch/cost-centre filters are reporting filters, not separate branch-restricted roles. Existing historical HR/commission balances must be reconciled explicitly.

## Commission policies, CRM automation and payroll

- `commission-policies` provides effective-dated employee, team and role defaults. Employee wins over team, which wins over role. A percentage applies to the brokerage commission; tier thresholds use the property value and choose a percentage of brokerage commission. Fixed commission is in EGP minor units. Agent plus lead shares cannot exceed earned brokerage commission. The selected policy is snapshotted into a booked deal; later revisions use that snapshot, not today's policy.
- `automation-rules` matches signed non-sample CRM contracts by contract type and optional CRM inventory project. A project-specific rule wins over the type-wide default. Rules start disabled. Enabling explicitly delegates posting to the current authorizer; an inactive user or lost finance permissions stops the automation. The existing finance worker processes eligible contracts every minute. A manual `automation-process` endpoint retries pending records. Each deal is atomic and idempotent; errors remain in the finance inbox. No new journal survives a failed installment or commission action. Linked installment plans are generated and approved only when the rule requests them. Cancellation reverses commissions and cancels the linked plan. Contract value changes with linked customer installments require manual reconciliation rather than guessing replacement terms.
- `staff-statements` and the existing `self` endpoint combine period sales, earned commissions, adjustments, cash settlement, advance offsets, salary liabilities, advance balances and recoveries, with dated journal activity. Sales can access only their own statement and team leads only their current team. Team views exclude other employees' salary and personal advance balances; those remain private to the employee and authorized Finance staff. Net position is informational and does not authorize taking all outstanding advances from a payment. Unlinked HR advances are flagged for reconciliation. CSV money exports retain exact two-decimal amounts.
- Payroll is at `/company/payroll`: salary profiles and one current payroll run per company/month. Profiles contain explicit base pay, allowances, approved recurring deductions with a reason, and an advance deduction cap. This is not a statutory tax, insurance, attendance-deduction or salary-proration calculator. Include employees explicitly; all selected employees require active profiles. Drafts snapshot amounts and scheduled advance allocations. Submit, independently approve (owner exception), then post. Changed salary profiles or advance balances require cancelling and regenerating the draft. Payroll Officers have only `payroll.read` and `payroll.manage`, not general financial data or approval rights. Owners and finance managers approve; accountants/payroll officers prepare.
- Advance deductions use the due cumulative monthly schedule less already recorded repayments, capped by available net salary and the configured percentage. Payouts and prior repayments must be reconciled with Finance before deduction. Posting creates salary expense, contra-expense for explicit approved deductions, salary advance recovery and net salary payable, and atomically records the HR repayment. Net salary is paid through the existing Finance voucher workflow; posting a run does not move money. Payroll reversal requires all net salary payments to be reversed first and restores HR balances and journals together. Generic HR repayment reversal and generic salary obligation reversal cannot bypass payroll corrections.
