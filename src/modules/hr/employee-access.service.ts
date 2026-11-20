import {
  Inject,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { ENV, type Environment } from "../../config/env.js";
import type { Principal } from "../../common/auth/access.js";
import {
  OwnerWelcomeService,
  seal,
} from "../identity/welcome/welcome.service.js";
@Injectable()
export class EmployeeAccessService {
  constructor(@Inject(ENV) private readonly env: Environment) {}
  async provision(
    c: PoolClient,
    p: Principal,
    employeeId: string,
    renew = false,
  ) {
    try {
      new OwnerWelcomeService(this.env).ready();
    } catch {
      throw new ServiceUnavailableException(
        "Employee activation email delivery is not configured. Contact the platform administrator.",
      );
    }
    const token = randomBytes(32).toString("hex"),
      generation = randomUUID();
    const payload = seal(
      JSON.stringify({ token, company: p.companyId }),
      this.env.WELCOME_ENCRYPTION_KEY!,
      employeeId + ":" + generation,
    );
    await c.query(
      "SELECT tenant.provision_employee_login($1,$2,$3,$4,$5,$6,$7)",
      [
        p.companyId,
        employeeId,
        p.id,
        createHash("sha256").update(token).digest("hex"),
        generation,
        payload,
        renew,
      ],
    );
  }
}
