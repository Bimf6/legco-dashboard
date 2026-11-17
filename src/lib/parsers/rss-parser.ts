import { XMLParser } from "fast-xml-parser";
import { fetchLegcoText, normalizeLegcoUrl } from "../legco-http";
import { extractPaperNo } from "./agenda-parser";

export interface ParsedRssDocument {
  docKey: string;
  paperNo: string;
  docType:
    | "paper"
    | "submission"
    | "reply"
    | "agenda"
    | "brief"
    | "bill"
    | "subleg"
    | "minutes"
    | "hansard"
    | "press";
  committeeNameEn: string;
  committeeNameTc: string;
  titleEn: string;
  titleTc: string;
  summaryEn: string;
  summaryTc: string;
  urlEn: string;
  urlTc: string;
  publishedAt: string;
  isRevisionNotice: boolean;
}

const RSS_FEED_PAIRS: Array<{
  en: string;
  tc: string;
  defaultType?: ParsedRssDocument["docType"];
}> = [
  { en: "https://www.legco.gov.hk/en/rss/ecounmtg.xml", tc: "https://www.legco.gov.hk/tc/rss/ccounmtg.xml" },
  { en: "https://www.legco.gov.hk/en/rss/epanels.xml", tc: "https://www.legco.gov.hk/tc/rss/cpanels.xml" },
  { en: "https://www.legco.gov.hk/en/rss/efc.xml", tc: "https://www.legco.gov.hk/tc/rss/cfc.xml" },
  { en: "https://www.legco.gov.hk/en/rss/ehc.xml", tc: "https://www.legco.gov.hk/tc/rss/chc.xml" },
  { en: "https://www.legco.gov.hk/en/rss/ebills.xml", tc: "https://www.legco.gov.hk/tc/rss/cbills.xml", defaultType: "bill" },
  { en: "https://www.legco.gov.hk/en/rss/ebc.xml", tc: "https://www.legco.gov.hk/tc/rss/cbc.xml" },
  { en: "https://www.legco.gov.hk/en/rss/esubleg.xml", tc: "https://www.legco.gov.hk/tc/rss/csubleg.xml", defaultType: "subleg" },
  { en: "https://www.legco.gov.hk/en/rss/ebriefs.xml", tc: "https://www.legco.gov.hk/tc/rss/cbriefs.xml", defaultType: "brief" },
  { en: "https://www.legco.gov.hk/en/rss/epress.xml", tc: "https://www.legco.gov.hk/tc/rss/cpress.xml", defaultType: "press" },
];

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  trimValues: true,
});

interface RawRssItem {
  title?: string;
  link?: string;
  guid?: string | { "#text"?: string };
  description?: string;
  pubDate?: string;
}

function normalizeUrlToPairKey(rawUrl: string): string {
  const url = normalizeLegcoUrl(rawUrl);
  return url
    .replace(/\/english\//i, "/{lang}/")
    .replace(/\/chinese\//i, "/{lang}/")
    .replace(/-(ec|e|c)\.pdf$/i, ".pdf")
    .replace(/_(e|c)\.pdf$/i, ".pdf")
    .toLowerCase();
}

function inferDocType(
  url: string,
  title: string,
  desc: string,
  fallback?: ParsedRssDocument["docType"],
): ParsedRssDocument["docType"] {
  const u = url.toLowerCase();
  const combined = `${title} ${desc}`;
  if (u.includes("/agenda/")) return "agenda";
  if (u.includes("/minutes/")) return "minutes";
  if (u.includes("/hansard/") || u.includes("/floor/")) return "hansard";
  if (u.includes("/brief/")) return "brief";
  if (u.includes("/bills/")) return "bill";
  if (u.includes("/subleg/")) return "subleg";
  if (/List of follow-up actions|List of outstanding items|跟進行動一覽表|待議事項一覽表|Background brief|背景資料簡介/i.test(combined)) {
    return fallback || "paper";
  }
  if (/Administration['’]s\s+response|Responses?\s+to\s+submissions?|當局就意見書?所作回應|政府當局.*回應/i.test(combined)) return "reply";
  if (/Submission from|Written submission|Deputation|提交的意見書|團體意見書/i.test(combined)) return "submission";
  if (u.includes("/press/")) return "press";
  return fallback || "paper";
}

function inferCommitteeName(title: string): string {
  return title
    .replace(/\s+(Paper|Agenda|Minutes|Hansard.*|Motion|Question|Report)$/i, "")
    .replace(/(文件|議程|會議紀要|會議過程正式紀錄|議案|質詢|報告)$/, "")
    .trim();
}

function buildSmartTitle(rawTitle: string, desc: string, lang: "en" | "tc"): string {
  const generic =
    /^(.*)\s+(Paper|Agenda|Minutes|Press Release Paper|Press Release)$/i.test(rawTitle) ||
    /(文件|議程|會議紀要|新聞稿文件|新聞稿)$/.test(rawTitle);

  const cleanedDesc = (desc || "")
    .replace(/The excerpt is not available\. Please read the document\./gi, "")
    .replace(/未能提供撮要，請閱讀文件。?/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!generic || cleanedDesc.length < 12) return rawTitle;

  const snippet = cleanedDesc.slice(0, lang === "en" ? 130 : 80);
  return `${rawTitle}: ${snippet}${cleanedDesc.length > snippet.length ? "…" : ""}`;
}

async function fetchSingleFeed(url: string): Promise<RawRssItem[]> {
  try {
    const res = await fetchLegcoText(url, 12000);
    if (res.status < 200 || res.status >= 300) return [];
    const parsed = xmlParser.parse(res.body) as {
      rss?: { channel?: { item?: RawRssItem | RawRssItem[] } };
    };
    const items = parsed?.rss?.channel?.item;
    if (!items) return [];
    return Array.isArray(items) ? items : [items];
  } catch {
    return [];
  }
}

export async function fetchAllLegcoRssDocuments(): Promise<ParsedRssDocument[]> {
  const byKey = new Map<string, ParsedRssDocument>();

  await Promise.all(
    RSS_FEED_PAIRS.map(async (pair) => {
      const [enItems, tcItems] = await Promise.all([
        fetchSingleFeed(pair.en),
        fetchSingleFeed(pair.tc),
      ]);

      for (const item of enItems.slice(0, 35)) {
        const link = normalizeLegcoUrl(item.link || "");
        if (!link) continue;
        const title = String(item.title || "").trim();
        const desc = String(item.description || "").trim();
        const paperNo = extractPaperNo(`${title} ${desc}`);
        const docKey = paperNo ? `paper:${paperNo}` : `url:${normalizeUrlToPairKey(link)}`;
        const pubDate = item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString();
        const isRevision = /revised agenda|rescheduled|postponed|cancel/i.test(`${title} ${desc}`);

        const existing = byKey.get(docKey);
        if (existing) {
          existing.urlEn = existing.urlEn || link;
          existing.titleEn = existing.titleEn || buildSmartTitle(title, desc, "en");
          existing.summaryEn = existing.summaryEn || desc.slice(0, 400);
          existing.committeeNameEn = existing.committeeNameEn || inferCommitteeName(title);
          existing.isRevisionNotice = existing.isRevisionNotice || isRevision;
        } else {
          byKey.set(docKey, {
            docKey,
            paperNo,
            docType: inferDocType(link, title, desc, pair.defaultType),
            committeeNameEn: inferCommitteeName(title),
            committeeNameTc: "",
            titleEn: buildSmartTitle(title, desc, "en"),
            titleTc: "",
            summaryEn: desc.slice(0, 400),
            summaryTc: "",
            urlEn: link,
            urlTc: "",
            publishedAt: pubDate,
            isRevisionNotice: isRevision,
          });
        }
      }

      for (const item of tcItems.slice(0, 35)) {
        const link = normalizeLegcoUrl(item.link || "");
        if (!link) continue;
        const title = String(item.title || "").trim();
        const desc = String(item.description || "").trim();
        const paperNo = extractPaperNo(`${title} ${desc}`);
        const docKey = paperNo ? `paper:${paperNo}` : `url:${normalizeUrlToPairKey(link)}`;
        const pubDate = item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString();
        const isRevision = /修訂議程|改期|押後|取消/i.test(`${title} ${desc}`);

        const existing = byKey.get(docKey);
        if (existing) {
          existing.urlTc = existing.urlTc || link;
          existing.titleTc = existing.titleTc || buildSmartTitle(title, desc, "tc");
          existing.summaryTc = existing.summaryTc || desc.slice(0, 400);
          existing.committeeNameTc = existing.committeeNameTc || inferCommitteeName(title);
          existing.isRevisionNotice = existing.isRevisionNotice || isRevision;
        } else {
          byKey.set(docKey, {
            docKey,
            paperNo,
            docType: inferDocType(link, title, desc, pair.defaultType),
            committeeNameEn: "",
            committeeNameTc: inferCommitteeName(title),
            titleEn: "",
            titleTc: buildSmartTitle(title, desc, "tc"),
            summaryEn: "",
            summaryTc: desc.slice(0, 400),
            urlEn: "",
            urlTc: link,
            publishedAt: pubDate,
            isRevisionNotice: isRevision,
          });
        }
      }
    }),
  );

  return Array.from(byKey.values()).map((d) => ({
    ...d,
    titleEn: d.titleEn || d.titleTc || d.paperNo || "LegCo Document",
    titleTc: d.titleTc || d.titleEn || d.paperNo || "立法會文件",
    committeeNameEn: d.committeeNameEn || d.committeeNameTc,
    committeeNameTc: d.committeeNameTc || d.committeeNameEn,
  }));
}
