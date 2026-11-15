import { Injectable } from "@nestjs/common";
import {
  KimiClient,
  type KimiMessage,
} from "../../../../infrastructure/ai/kimi.client.js";
@Injectable()
export class KimiTeamInsightsGateway {
  createClient() {
    return KimiClient.fromEnvironment({
      ...process.env,
      KIMI_TIMEOUT_MS: "120000",
    });
  }
  assertConfigured() {
    this.createClient();
  }
  complete(messages: KimiMessage[], tokens: number) {
    return this.createClient().complete(messages, tokens);
  }
}
