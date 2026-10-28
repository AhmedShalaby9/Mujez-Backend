import { AsyncLocalStorage } from "node:async_hooks";
export const auditContext = new AsyncLocalStorage<{ ip?: string }>();
