import { Global, Module } from "@nestjs/common";
import { OwnerWelcomeService } from "./welcome.service.js";
@Global()
@Module({ providers: [OwnerWelcomeService], exports: [OwnerWelcomeService] })
export class OwnerWelcomeModule {}
