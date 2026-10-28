import { Module } from "@nestjs/common";
import {
  SystemHealthController,
  SystemHealthService,
  OperationalMetrics,
} from "./system-health.js";
@Module({
  controllers: [SystemHealthController],
  providers: [OperationalMetrics, SystemHealthService],
  exports: [OperationalMetrics],
})
export class PlatformHealthModule {}
