import { SetMetadata } from "@nestjs/common";
export const ACCESS = "mujez:access";
export type Pool = "company_admin" | "company_user" | "platform";
export type Access = { public: true } | { pools: Pool[]; permission?: string };
export const Public = () =>
  SetMetadata(ACCESS, { public: true } satisfies Access);
export const RequireAccess = (pools: Pool[], permission?: string) =>
  SetMetadata(ACCESS, { pools, permission } satisfies Access);
export interface Principal {
  id: string;
  subject: string;
  pool: Pool;
  companyId?: string;
  name: string;
  email: string;
  role: string;
  permissions: string[];
  scope: "own" | "team" | "company" | "platform";
  teamId?: string;
}
