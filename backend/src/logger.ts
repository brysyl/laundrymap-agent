import pino from "pino";

export type Logger = pino.Logger;

export function createLogger(level = "info"): Logger {
  return pino({
    level,
    redact: {
      paths: ["req.headers.authorization", "req.headers.cookie", "req.headers['x-paystack-signature']", "*.password", "*.otp"],
      censor: "[redacted]",
    },
  });
}
