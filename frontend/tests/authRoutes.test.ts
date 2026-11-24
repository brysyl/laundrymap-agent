import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { authHref, parseAuthMode } from "../src/lib/authRoutes";

describe("authRoutes", () => {
  it("parses the mode query value", () => {
    expect(parseAuthMode("register")).toBe("register");
    expect(parseAuthMode("login")).toBe("login");
    expect(parseAuthMode(["register", "login"])).toBe("register");
    expect(parseAuthMode(null)).toBe("login");
    expect(parseAuthMode("bogus")).toBe("login");
  });
  it("falls back to the pathname", () => {
    expect(parseAuthMode(null, "/register")).toBe("register");
    expect(parseAuthMode(undefined, "/register/")).toBe("register");
    expect(parseAuthMode(null, "/login")).toBe("login");
    expect(parseAuthMode("login", "/register")).toBe("login");
  });
  it("builds hrefs", () => {
    expect(authHref("login")).toBe("/auth");
    expect(authHref("register")).toBe("/auth?mode=register");
  });
});

describe("home page", () => {
  const src = readFileSync(join(__dirname, "../app/page.tsx"), "utf8");
  it("is a static server component with no redirect or API call", () => {
    expect(src).not.toMatch(/["']use client["']/);
    expect(src).not.toMatch(/router\.replace|router\.push|redirect\(/);
    expect(src).not.toMatch(/fetch\(|lib\/api|useEffect/);
  });
});
