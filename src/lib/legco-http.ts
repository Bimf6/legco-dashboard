import https from "node:https";
import tls from "node:tls";
import { HK_POST_ICA_PEM } from "./legco-ca";

const ALLOWED_HOSTS = new Set(["www.legco.gov.hk", "app.legco.gov.hk"]);

const legcoAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 10,
  ca: [...tls.rootCertificates, HK_POST_ICA_PEM],
  rejectUnauthorized: true,
});

export interface LegcoResponse {
  status: number;
  etag: string | null;
  lastModified: string | null;
  body: string;
}

export function assertLegcoUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname)) {
    throw new Error(`Disallowed LegCo host: ${url.hostname}`);
  }
  return url;
}

export function normalizeLegcoUrl(raw: string | null | undefined): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("/")) {
    return `https://www.legco.gov.hk${trimmed}`;
  }
  if (trimmed.startsWith("http://www.legco.gov.hk")) {
    return trimmed.replace("http://", "https://");
  }
  if (trimmed.startsWith("http://app.legco.gov.hk")) {
    return trimmed.replace("http://", "https://");
  }
  return trimmed;
}

export function fetchLegcoText(
  rawUrl: string,
  timeoutMs = 15000,
): Promise<LegcoResponse> {
  const url = assertLegcoUrl(normalizeLegcoUrl(rawUrl));

  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: "GET",
        agent: legcoAgent,
        headers: {
          "User-Agent": "LegCo-Monitor/1.0 (Hong Kong Legislative Council Open Data)",
          Accept: "application/json, application/xml, text/xml, text/html, */*",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode ?? 0,
            etag: typeof res.headers.etag === "string" ? res.headers.etag : null,
            lastModified:
              typeof res.headers["last-modified"] === "string"
                ? res.headers["last-modified"]
                : null,
            body,
          });
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Timeout fetching ${url.toString()}`));
    });

    req.on("error", reject);
    req.end();
  });
}

export async function fetchLegcoJson<T>(rawUrl: string, timeoutMs = 18000): Promise<T> {
  const res = await fetchLegcoText(rawUrl, timeoutMs);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`HTTP ${res.status} from ${rawUrl}`);
  }
  if (res.body.trimStart().startsWith("<!DOCTYPE html") || res.body.includes('data-unit="page-not-found"')) {
    throw new Error(`LegCo returned HTML 404 page for ${rawUrl}`);
  }
  return JSON.parse(res.body) as T;
}
