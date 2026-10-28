import {
  Global,
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { createClient } from "redis";
import { ENV, type Environment } from "../../config/env.js";
@Injectable()
export class CacheService implements OnApplicationShutdown {
  private readonly client;
  constructor(@Inject(ENV) env: Environment) {
    this.client = createClient({
      url: env.REDIS_URL,
      socket: { connectTimeout: 1500, reconnectStrategy: false },
    });
    this.client.on("error", () => {});
  }
  async consume(key: string, limit: number, seconds: number): Promise<boolean> {
    if (!this.client.isOpen) await this.client.connect();
    const count = await this.client.eval(
      "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n",
      { keys: [key], arguments: [String(seconds)] },
    );
    return Number(count) <= limit;
  }
  async ready(): Promise<void> {
    if (!this.client.isOpen) await this.client.connect();
    await this.client.ping();
  }
  async onApplicationShutdown(): Promise<void> {
    if (this.client.isOpen) this.client.destroy();
  }
}
@Global()
@Module({ providers: [CacheService], exports: [CacheService] })
export class CacheModule {}
