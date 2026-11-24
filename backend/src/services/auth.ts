import { randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import jwt from "jsonwebtoken";
import { promisify } from "node:util";
import type { Config } from "../config";
import { badRequest, forbidden, unauthorized } from "../errors";
import type { Store } from "../store/store";
import type { Clock, Courier, Role, User, Vendor } from "../types";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, s, h] = stored.split("$");
  if (alg !== "scrypt" || !s || !h) return false;
  const expected = Buffer.from(h, "base64");
  const got = await scrypt(pw, Buffer.from(s, "base64"), expected.length);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export interface TokenClaims { sub: string; role: Role }

export interface RegisterInput {
  name: string;
  email: string;
  phone: string;
  password: string;
  role: Exclude<Role, "ADMIN">;
  vendor?: { name: string; address: string; lat: number; lng: number; unitPriceKobo: number };
}

export class AuthService {
  constructor(private readonly store: Store, private readonly config: Config, private readonly clock: Clock) {}

  signToken(user: User): string {
    return jwt.sign({ role: user.role }, this.config.jwtSecret, {
      algorithm: "HS256", subject: user.id, expiresIn: this.config.jwtTtlSeconds, issuer: "laundrymap",
    });
  }

  /** Verifies the token and loads the live user, so suspension takes effect immediately. */
  async authenticate(token: string): Promise<User> {
    let claims: jwt.JwtPayload;
    try {
      const v = jwt.verify(token, this.config.jwtSecret, { algorithms: ["HS256"], issuer: "laundrymap" });
      if (typeof v === "string" || !v.sub) throw new Error("bad claims");
      claims = v;
    } catch {
      throw unauthorized("Invalid or expired token");
    }
    const user = await this.store.getUser(String(claims.sub));
    if (!user) throw unauthorized("Invalid or expired token");
    if (user.status !== "ACTIVE") throw forbidden("Account suspended");
    return user;
  }

  /** Reloads a live, active user by id (used by socket room joins). */
  async reloadActive(id: string): Promise<User> {
    const user = await this.store.getUser(id);
    if (!user) throw unauthorized();
    if (user.status !== "ACTIVE") throw forbidden("Account suspended");
    return user;
  }

  async register(input: RegisterInput): Promise<{ user: User; vendor?: Vendor; courier?: Courier }> {
    const user: User = {
      id: randomUUID(), email: input.email.toLowerCase(), phone: input.phone, name: input.name, role: input.role,
      passwordHash: await hashPassword(input.password), status: "ACTIVE", createdAt: this.clock.now(),
    };
    return this.store.tx(async (s) => {
      await s.createUser(user);
      if (input.role === "VENDOR") {
        if (!input.vendor) throw badRequest("vendor_required", "vendor details required");
        const vendor = await s.createVendor({
          id: randomUUID(), ownerId: user.id, ...input.vendor, status: "PENDING", createdAt: this.clock.now(),
        });
        return { user, vendor };
      }
      if (input.role === "COURIER") {
        const courier = await s.createCourier({
          id: randomUUID(), userId: user.id, status: "PENDING", lat: null, lng: null, locationAt: null, createdAt: this.clock.now(),
        });
        return { user, courier };
      }
      return { user };
    });
  }

  async login(identifier: string, password: string): Promise<{ user: User; token: string }> {
    const user = identifier.includes("@") ? await this.store.getUserByEmail(identifier) : await this.store.getUserByPhone(identifier);
    // Always run a hash comparison to keep timing similar for unknown users.
    const ok = await verifyPassword(password, user?.passwordHash ?? "scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAA");
    if (!user || !ok) throw unauthorized("Invalid credentials");
    if (user.status !== "ACTIVE") throw forbidden("Account suspended");
    return { user, token: this.signToken(user) };
  }

  async ensureAdmin(a: { email: string; phone: string; password: string }): Promise<void> {
    if (await this.store.getUserByEmail(a.email)) return;
    await this.store.createUser({
      id: randomUUID(), email: a.email.toLowerCase(), phone: a.phone, name: "Administrator", role: "ADMIN",
      passwordHash: await hashPassword(a.password), status: "ACTIVE", createdAt: this.clock.now(),
    });
  }
}
