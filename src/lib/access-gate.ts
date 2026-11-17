import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { getIdentity } from "../../cursor/identity";

export const PASSCODE_COOKIE_NAME = "legco_access";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type AuthResult =
  | {
      authorized: true;
      viewerSub: string;
      viewerName: string;
      simulated: boolean;
      passcodeEnabled: boolean;
    }
  | {
      authorized: false;
      response: NextResponse;
    };

function getConfiguredPasscode(): string {
  return process.env.APP_PASSCODE?.trim() ?? "";
}

function getSigningKey(passcode: string): Buffer {
  return crypto.createHash("sha256").update(`legco-session:${passcode}`).digest();
}

export function isPasscodeConfigured(): boolean {
  return getConfiguredPasscode() !== "";
}

export function verifyPasscodeCandidate(candidate: string): boolean {
  const configured = getConfiguredPasscode();
  if (!configured || !candidate) return false;
  const a = crypto.createHash("sha256").update(candidate).digest();
  const b = crypto.createHash("sha256").update(configured).digest();
  return crypto.timingSafeEqual(a, b);
}

export function createAccessCookieToken(): string | null {
  const configured = getConfiguredPasscode();
  if (!configured) return null;
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const nonce = crypto.randomBytes(12).toString("hex");
  const payload = `${expiresAt}.${nonce}`;
  const sig = crypto
    .createHmac("sha256", getSigningKey(configured))
    .update(payload)
    .digest("hex");
  return `${payload}.${sig}`;
}

function readCookieValue(request: Request, name: string): string {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    if (k === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return "";
}

export function verifyAccessCookie(request: Request): boolean {
  const configured = getConfiguredPasscode();
  if (!configured) return false;
  const token = readCookieValue(request, PASSCODE_COOKIE_NAME);
  if (!token) return false;

  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [expStr, nonce, sigHex] = parts;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp <= Date.now() || !nonce || !sigHex) {
    return false;
  }

  const expectedHex = crypto
    .createHmac("sha256", getSigningKey(configured))
    .update(`${expStr}.${nonce}`)
    .digest("hex");

  const sigBuf = Buffer.from(sigHex, "utf8");
  const expectedBuf = Buffer.from(expectedHex, "utf8");
  if (sigBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expectedBuf);
}

export async function authorizeRequest(request: Request): Promise<AuthResult> {
  const identity = await getIdentity(request);
  const passcodeConfigured = isPasscodeConfigured();

  if (passcodeConfigured) {
    if (verifyAccessCookie(request)) {
      const viewerName = identity.verified
        ? identity.kind === "person"
          ? identity.name || identity.email || "Teammate"
          : identity.name
        : "Teammate";
      return {
        authorized: true,
        viewerSub: identity.verified ? identity.sub : "shared:passcode",
        viewerName,
        simulated: identity.verified ? Boolean(identity.simulated) : false,
        passcodeEnabled: true,
      };
    }

    return {
      authorized: false,
      response: NextResponse.json(
        { error: "Passcode required", reason: "passcode_required", passcodeConfigured: true },
        { status: 401, headers: { "cache-control": "private, no-store" } },
      ),
    };
  }

  if (identity.verified) {
    return {
      authorized: true,
      viewerSub: identity.sub,
      viewerName:
        identity.kind === "person" ? identity.name || identity.email || "Viewer" : identity.name,
      simulated: Boolean(identity.simulated),
      passcodeEnabled: false,
    };
  }

  return {
    authorized: false,
    response: NextResponse.json(
      {
        error: "Access restricted: configure APP_PASSCODE secret or publish as Team/Private",
        reason: "passcode_not_configured",
        passcodeConfigured: false,
      },
      { status: 401, headers: { "cache-control": "private, no-store" } },
    ),
  };
}
