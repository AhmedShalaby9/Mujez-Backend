import { Injectable, Controller, Get } from "@nestjs/common";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { CacheService } from "../../../infrastructure/cache/cache.module.js";
import { RequireAccess } from "../../../common/auth/access.js";
@Injectable()
export class OperationalMetrics {
  readonly startedAt = new Date().toISOString();
  private buckets = new Map<
    number,
    { requests: number; errors: number; clientErrors: number }
  >();
  private durations: number[] = [];
  record(status: number, duration: number, now = Date.now()) {
    const hour = Math.floor(now / 3600000);
    const b = this.buckets.get(hour) ?? {
      requests: 0,
      errors: 0,
      clientErrors: 0,
    };
    b.requests++;
    if (status >= 500) b.errors++;
    else if (status >= 400) b.clientErrors++;
    this.buckets.set(hour, b);
    for (const k of this.buckets.keys())
      if (k < hour - 23) this.buckets.delete(k);
    this.durations.push(duration);
    if (this.durations.length > 10000) this.durations.shift();
  }
  snapshot(now = Date.now()) {
    const hour = Math.floor(now / 3600000),
      sorted = [...this.durations].sort((a, b) => a - b);
    const bars = Array.from({ length: 24 }, (_, i) => {
      const t = hour - 23 + i;
      const b = this.buckets.get(t);
      return {
        hour: new Date(t * 3600000).toISOString(),
        observed: t * 3600000 + 3600000 > new Date(this.startedAt).getTime(),
        requests: b?.requests ?? 0,
        errors: b?.errors ?? 0,
        clientErrors: b?.clientErrors ?? 0,
      };
    });
    const requests = bars.reduce((n, b) => n + b.requests, 0),
      errors = bars.reduce((n, b) => n + b.errors, 0);
    const percentile = (p: number) =>
      sorted.length
        ? Math.round(sorted[Math.ceil(sorted.length * p) - 1]!)
        : null;
    return {
      startedAt: this.startedAt,
      window:
        "Process-local, up to 24 hours; latency uses latest 10,000 requests",
      requests,
      errors,
      errorRate: requests
        ? Math.round((errors / requests) * 10000) / 100
        : null,
      p50: percentile(0.5),
      p95: percentile(0.95),
      bars,
    };
  }
}
@Injectable()
export class SystemHealthService {
  constructor(
    private readonly db: DatabaseService,
    private readonly cache: CacheService,
    private readonly metrics: OperationalMetrics,
  ) {}
  async snapshot() {
    const probe = async (check: () => Promise<void>) => {
      const start = performance.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          check(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("timeout")), 6000);
          }),
        ]);
        return {
          status: "healthy",
          latencyMs: Math.round(performance.now() - start),
        };
      } catch {
        return { status: "down", latencyMs: null };
      } finally {
        clearTimeout(timer);
      }
    };
    let workerSeenAt: string | null = null;
    const [database, redis, routingWorker] = await Promise.all([
      probe(() => this.db.ready()),
      probe(() => this.cache.ready()),
      probe(async () => {
        const r = await this.db.platform(
          async (c) =>
            (
              await c.query(
                "SELECT seen_at,seen_at>now()-interval '2 minutes' AS healthy FROM platform.worker_heartbeats WHERE key='lead-routing'",
              )
            ).rows[0],
        );
        workerSeenAt = r?.seen_at ? new Date(r.seen_at).toISOString() : null;
        if (!r?.healthy) throw Error("Worker heartbeat stale");
      }),
    ]);
    const observedAt = new Date().toISOString();
    const alerts = [
      ["db", database],
      ["redis", redis],
    ]
      .filter(([, s]) => (s as any).status === "down")
      .map(([service]) => ({
        id: "probe-" + service,
        severity: "critical",
        service,
        messageEn: service + " readiness check failed",
        messageAr: "فشل فحص جاهزية " + service,
        time: observedAt,
      }));
    if (routingWorker.status === "down")
      alerts.push({
        id: "probe-lead-routing",
        severity: "warning",
        service: "lead-routing",
        messageEn: "Lead routing worker heartbeat is missing or stale",
        messageAr: "إشارة عامل توزيع العملاء مفقودة أو قديمة",
        time: observedAt,
      });
    return {
      observedAt,
      status: alerts.length ? "degraded" : "healthy",
      database,
      redis,
      routingWorker: { ...routingWorker, lastSeenAt: workerSeenAt },
      uptimeSeconds: Math.floor(process.uptime()),
      memoryMb: Math.round(process.memoryUsage().rss / 1048576),
      connections: this.db.poolStats(),
      activeJobs: null,
      storageBytes: null,
      metrics: this.metrics.snapshot(),
      alerts,
    };
  }
}
@Controller("admin/api/v1/system-health")
export class SystemHealthController {
  constructor(private readonly service: SystemHealthService) {}
  @Get() @RequireAccess(["platform"], "health") snapshot() {
    return this.service.snapshot();
  }
}
