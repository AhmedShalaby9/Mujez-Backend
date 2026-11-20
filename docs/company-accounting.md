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

Initial accounting is EGP only. No bank API payments, automatic payroll deductions, statutory tax filing, ETA submission or WhatsApp provider integration is enabled. Finance roles have company-wide finance access; branch/cost-centre filters are reporting filters, not separate branch-restricted roles. Existing historical HR/commission balances must be reconciled explicitly.
