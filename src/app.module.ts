import { Global, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { ENV, parseEnvironment } from "./config/env.js";
import { DatabaseModule } from "./infrastructure/database/database.module.js";
import { CacheModule } from "./infrastructure/cache/cache.module.js";
import { AccessGuard } from "./common/auth/access.guard.js";
import { TokenVerifier } from "./common/auth/token-verifier.service.js";
import { PrincipalService } from "./common/auth/principal.service.js";
import { TokenThrottlerGuard } from "./common/auth/token-throttler.guard.js";
import { HealthController } from "./modules/health/health.controller.js";
import {
  TenantMeController,
  PlatformMeController,
} from "./modules/identity/me.controller.js";
import { DOMAIN_MODULES } from "./domain-modules.js";
@Global()
@Module({
  providers: [
    { provide: ENV, useFactory: () => parseEnvironment(process.env) },
  ],
  exports: [ENV],
})
class EnvironmentModule {}
@Module({
  imports: [
    EnvironmentModule,
    DatabaseModule,
    CacheModule,
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 120 }]),
    ...DOMAIN_MODULES,
  ],
  controllers: [HealthController, TenantMeController, PlatformMeController],
  providers: [
    TokenVerifier,
    PrincipalService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: TokenThrottlerGuard },
    { provide: APP_GUARD, useClass: AccessGuard },
  ],
})
export class AppModule {}
