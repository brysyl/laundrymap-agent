import type { Config } from "./config";
import type { Cache } from "./cache/cache";
import type { Logger } from "./logger";
import type { Publisher } from "./realtime/events";
import { AuthService } from "./services/auth";
import type { PaymentGateway } from "./services/gateway";
import { OrderService } from "./services/orders";
import { OtpService } from "./services/otp";
import { PaymentService } from "./services/payments";
import type { Store } from "./store/store";
import type { Clock } from "./types";

export interface ContainerInput {
  config: Config;
  store: Store;
  cache: Cache;
  gateway: PaymentGateway;
  clock: Clock;
  logger: Logger;
  publish: Publisher;
}

export interface Container extends ContainerInput {
  auth: AuthService;
  otp: OtpService;
  orders: OrderService;
  payments: PaymentService;
}

export function buildContainer(i: ContainerInput): Container {
  const otp = new OtpService(
    { encryptionKey: i.config.otpEncryptionKey, ttlMs: i.config.otpTtlMs, maxAttempts: i.config.otpMaxAttempts, lockMs: i.config.otpLockMs },
    i.clock,
  );
  const orders = new OrderService({ ...i, otp });
  return {
    ...i,
    auth: new AuthService(i.store, i.config, i.clock),
    otp,
    orders,
    payments: new PaymentService(i.store, orders, i.config.paystackSecretKey, i.clock, i.logger),
  };
}
