import { SupportService } from "../../dist/modules/platform/support/support.service.js";
import { AnnouncementsService } from "../../dist/modules/platform/announcements/announcements.service.js";
export async function seedSupportAnnouncements(client) {
  const actor = (
    await client.query(
      "SELECT u.id FROM platform.users u JOIN platform.roles r ON r.id=u.role_id WHERE r.key='super_admin' AND u.status='active' ORDER BY u.created_at LIMIT 1",
    )
  ).rows[0];
  if (!actor) throw Error("Provision an active Super Admin first");
  const db = { platform: (work) => work(client) },
    support = new SupportService(db),
    announcements = new AnnouncementsService(db);
  const tickets = [
    [
      "initial-onboarding",
      "mujez-sample-brokerage",
      "[Sample] Onboarding checklist review",
      "[تجريبي] مراجعة قائمة التأهيل",
      "tech",
      "med",
      "open",
    ],
    [
      "initial-billing",
      "mujez-sample-developer",
      "[Sample] Review sample invoice",
      "[تجريبي] مراجعة الفاتورة التجريبية",
      "billing",
      "high",
      "progress",
    ],
    [
      "initial-team-access",
      "mujez-sample-management",
      "[Sample] Team access planning",
      "[تجريبي] تخطيط صلاحيات الفريق",
      "access",
      "low",
      "waiting",
    ],
  ];
  for (const [key, slug, en, ar, category, priority, status] of tickets) {
    if (
      (
        await client.query(
          "SELECT 1 FROM platform.support_tickets WHERE seed_key=$1",
          [key],
        )
      ).rowCount
    )
      continue;
    const company = (
      await client.query(
        "SELECT public_id FROM platform.companies WHERE slug=$1",
        [slug],
      )
    ).rows[0];
    if (!company) throw Error("Run the sample companies seeder first");
    const ticket = await support.create(
      {
        companyId: company.public_id,
        subjectEn: en,
        subjectAr: ar,
        category,
        priority,
        requester: "Mujez staging sample",
        message:
          "Initial seed ticket for staff training. Replace with a real request when testing your workflow. No customer message or external delivery has occurred.",
      },
      actor.id,
      key,
    );
    if (status !== "open")
      await support.change(
        ticket.id,
        { version: 0, action: "status", status },
        actor.id,
      );
  }
  for (const [key, en, ar, target, type] of [
    [
      "initial-welcome",
      "[Sample] Welcome to Mujez",
      "[تجريبي] مرحبًا بكم في مجاز",
      "all",
      "update",
    ],
    [
      "initial-maintenance",
      "[Sample] Maintenance notice template",
      "[تجريبي] قالب إشعار الصيانة",
      "all",
      "maint",
    ],
    [
      "initial-plan-notice",
      "[Sample] Pro plan notice template",
      "[تجريبي] قالب إعلان باقة Pro",
      "pro",
      "feature",
    ],
  ]) {
    if (
      (
        await client.query(
          "SELECT 1 FROM platform.announcements WHERE seed_key=$1",
          [key],
        )
      ).rowCount
    )
      continue;
    await announcements.save(
      null,
      {
        version: 0,
        titleEn: en,
        titleAr: ar,
        bodyEn:
          "Sample draft. Replace this text with approved information and select a publishing window before publishing.",
        bodyAr:
          "مسودة تجريبية. استبدل هذا النص بمعلومات معتمدة وحدد فترة النشر قبل النشر.",
        type,
        target,
        lang: "both",
        from: null,
        to: null,
        published: false,
      },
      actor.id,
      key,
    );
  }
}
