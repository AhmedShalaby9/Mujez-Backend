import { SalesLeadsModule } from "./modules/sales/leads/leads.module.js";
import { SalesContactsModule } from "./modules/sales/contacts/contacts.module.js";
import { SalesPipelineModule } from "./modules/sales/pipeline/pipeline.module.js";
import { SalesTasksModule } from "./modules/sales/tasks/tasks.module.js";
import { SalesCalendarModule } from "./modules/sales/calendar/calendar.module.js";
import { InventoryProjectsModule } from "./modules/inventory/projects/projects.module.js";
import { InventoryUnitsModule } from "./modules/inventory/units/units.module.js";
import { InventoryReservationsModule } from "./modules/inventory/reservations/reservations.module.js";
import { InventoryImportsModule } from "./modules/inventory/imports/imports.module.js";
import { FinanceContractsModule } from "./modules/finance/contracts/contracts.module.js";
import { FinanceCommissionsModule } from "./modules/finance/commissions/commissions.module.js";
import { FinanceDocumentsModule } from "./modules/finance/documents/documents.module.js";
import { GrowthMarketingModule } from "./modules/growth/marketing/marketing.module.js";
import { GrowthReportsModule } from "./modules/growth/reports/reports.module.js";
import { AdministrationRoutingModule } from "./modules/administration/routing/routing.module.js";
import { AdministrationNotificationsModule } from "./modules/administration/notifications/notifications.module.js";
import { AdministrationAuditModule } from "./modules/administration/audit/audit.module.js";
import { PlatformCompaniesModule } from "./modules/platform/companies/companies.module.js";
import { PlatformSubscriptionsModule } from "./modules/platform/subscriptions/subscriptions.module.js";
import { PlatformBillingModule } from "./modules/platform/billing/billing.module.js";
import { PlatformFeaturesModule } from "./modules/platform/features/features.module.js";
import { PlatformUsageModule } from "./modules/platform/usage/usage.module.js";
import { PlatformIntegrationsModule } from "./modules/platform/integrations/integrations.module.js";
import { PlatformSupportModule } from "./modules/platform/support/support.module.js";
import { PlatformAnnouncementsModule } from "./modules/platform/announcements/announcements.module.js";
import { PlatformRolesModule } from "./modules/platform/roles/roles.module.js";
import { PlatformSettingsModule } from "./modules/platform/settings/settings.module.js";
import { PlatformHealthModule } from "./modules/platform/health/health.module.js";

export const DOMAIN_MODULES = [
  SalesLeadsModule,
  SalesContactsModule,
  SalesPipelineModule,
  SalesTasksModule,
  SalesCalendarModule,
  InventoryProjectsModule,
  InventoryUnitsModule,
  InventoryReservationsModule,
  InventoryImportsModule,
  FinanceContractsModule,
  FinanceCommissionsModule,
  FinanceDocumentsModule,
  GrowthMarketingModule,
  GrowthReportsModule,
  AdministrationRoutingModule,
  AdministrationNotificationsModule,
  AdministrationAuditModule,
  PlatformCompaniesModule,
  PlatformSubscriptionsModule,
  PlatformBillingModule,
  PlatformFeaturesModule,
  PlatformUsageModule,
  PlatformIntegrationsModule,
  PlatformSupportModule,
  PlatformAnnouncementsModule,
  PlatformRolesModule,
  PlatformSettingsModule,
  PlatformHealthModule,
];
