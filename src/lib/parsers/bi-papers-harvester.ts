import { fetchLegcoJson, normalizeLegcoUrl } from "../legco-http";

export interface BiPaperCategory {
  en?: string;
  tc?: string;
  cat_id?: string;
  list?: BiPaperCategory[];
}

export interface BiPapersIndex {
  term?: string;
  paper?: BiPaperCategory[];
}

export interface BiPaperEntry {
  paper_no?: string;
  paper_no_display?: { en?: string; tc?: string };
  title?: { en?: string; tc?: string };
  pdf?: { en?: string; tc?: string };
  date?: Array<{ value?: string; type?: string }>;
  note?: Array<{ value?: string; type?: string }>;
}

export interface BiCategoryPayload {
  category?: { en?: string; tc?: string };
  papers?: Array<{
    session?: string;
    list?: BiPaperEntry[];
  }>;
}

export interface HarvestedCommitteeDoc {
  paperNo: string;
  docType: "submission" | "reply" | "paper" | "brief" | "bill";
  titleEn: string;
  titleTc: string;
  urlEn: string;
  urlTc: string;
  issueDate: string;
  meetingDate: string;
  replyToPaperNo: string;
  relatedPaperNo: string;
  categoryEn: string;
  categoryTc: string;
}

const PANEL_SLUG_BY_CODE: Record<string, string> = {
  "PL/AJLS": "administration-of-justice-and-legal-services",
  "PL/CA": "constitutional-affairs",
  "PL/CI": "commerce-industry-innovation-and-technology",
  "PL/DEV": "development",
  "PL/ED": "education",
  "PL/EDEV": "economic-development",
  "PL/EA": "environmental-affairs",
  "PL/FA": "financial-affairs",
  "PL/FSEH": "food-safety-and-environmental-hygiene",
  "PL/HA": "home-affairs-culture-and-sports",
  "PL/HG": "housing",
  "PL/HS": "health-services",
  "PL/ITB": "information-technology-and-broadcasting",
  "PL/MP": "manpower",
  "PL/PS": "public-service",
  "PL/SE": "security",
  "PL/TP": "transport",
  "PL/WS": "welfare-services",
};

export function resolvePapersBaseDirFromHomeUrl(
  homeUrl: string,
  committeeCode?: string | null,
): string | null {
  if (!homeUrl) return null;
  try {
    const u = new URL(normalizeLegcoUrl(homeUrl));
    const path = u.pathname.toLowerCase();
    const qs = u.search.replace(/^\?/, "");
    const parts = qs.split("&").filter(Boolean);

    if (path.endsWith("/bills-committee.html") && parts.length >= 2) {
      const [year, comm] = parts;
      if (/^\d{4}$/.test(year) && /^bc\d+/i.test(comm)) {
        const term = yearToTerm(year);
        return `https://www.legco.gov.hk/bi/data/committees/bills-committee/${term}/${year}/${comm}/papers`;
      }
    }

    if (path.endsWith("/finance-committee.html") && parts.length >= 1) {
      const term = normalizeTerm(parts[0]);
      return `https://www.legco.gov.hk/bi/data/committees/finance-committee/${term}/papers`;
    }

    if (path.endsWith("/establishment-subcommittee.html") && parts.length >= 1) {
      const term = normalizeTerm(parts[0]);
      return `https://www.legco.gov.hk/bi/data/committees/fc-subcommittees/establishment/${term}/papers`;
    }

    if (path.endsWith("/public-works-subcommittee.html") && parts.length >= 1) {
      const term = normalizeTerm(parts[0]);
      return `https://www.legco.gov.hk/bi/data/committees/fc-subcommittees/public-works/${term}/papers`;
    }

    if (path.endsWith("/house-committee.html") && parts.length >= 1) {
      const term = normalizeTerm(parts[0]);
      return `https://www.legco.gov.hk/bi/data/committees/house-committee/${term}/papers`;
    }

    if (path.includes("/panels/") && parts.length >= 1) {
      const term = normalizeTerm(parts[0]);
      const slugMatch = path.match(/\/panels\/([a-z0-9-]+)\.html$/);
      const slug = slugMatch?.[1] || (committeeCode ? PANEL_SLUG_BY_CODE[committeeCode] : "");
      if (slug) {
        return `https://www.legco.gov.hk/bi/data/committees/panels/${slug}/${term}/papers`;
      }
    }

    if (committeeCode && PANEL_SLUG_BY_CODE[committeeCode]) {
      return `https://www.legco.gov.hk/bi/data/committees/panels/${PANEL_SLUG_BY_CODE[committeeCode]}/term-08/papers`;
    }

    if (path.endsWith("/subcommittees-under-panels.html") && parts.length >= 1) {
      const dotParts = parts[0].split(".");
      if (dotParts.length === 2) {
        const term = normalizeTerm(dotParts[0]);
        return `https://www.legco.gov.hk/bi/data/committees/panels-subcommittees/${term}/${dotParts[1]}/papers`;
      }
    }

    if (
      (path.endsWith("/subcommittees-on-subsidiary-legislation.html") ||
        path.endsWith("/subsidiary-legislation-subcommittee.html")) &&
      parts.length >= 2
    ) {
      const [year, comm] = parts;
      const term = yearToTerm(year);
      return `https://www.legco.gov.hk/bi/data/committees/hc-subcommittees/subsidiary-legislation/${term}/${year}/${comm}/papers`;
    }

    if (path.endsWith("/other-subcommittees.html") && parts.length >= 2) {
      const [year, comm] = parts;
      const term = yearToTerm(year);
      return `https://www.legco.gov.hk/bi/data/committees/hc-subcommittees/other-subcommittees/${term}/${year}/${comm}/papers`;
    }
  } catch {
    return null;
  }
  return null;
}

function yearToTerm(yearStr: string): string {
  const y = Number(yearStr);
  if (y >= 2026) return "term-08";
  if (y >= 2022) return "term-07";
  return "term-06";
}

function normalizeTerm(raw: string): string {
  const clean = raw.replace(/[^0-9]/g, "").padStart(2, "0");
  return `term-${clean}`;
}

function flattenCatIds(categories: BiPaperCategory[] | undefined): string[] {
  if (!categories) return [];
  const ids: string[] = [];
  for (const c of categories) {
    if (c.cat_id) ids.push(c.cat_id);
    if (c.list) ids.push(...flattenCatIds(c.list));
  }
  return ids;
}

function stripTags(raw: string | undefined): string {
  if (!raw) return "";
  return raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

export async function harvestCommitteeBiPapers(
  baseDir: string,
  priorityCatIds: string[] = [],
  maxCats = 5,
): Promise<HarvestedCommitteeDoc[]> {
  let index: BiPapersIndex;
  try {
    index = await fetchLegcoJson<BiPapersIndex>(`${baseDir}/papers.json`, 10000);
  } catch {
    return [];
  }

  const allCatIds = flattenCatIds(index.paper);
  if (allCatIds.length === 0) return [];

  // Prioritize submission categories ('d', or categories with 'submission' / '意見書' in label)
  const submissionCats = (index.paper || [])
    .filter((c) => /submission|deputation|意見書/i.test(`${c.en || ""} ${c.tc || ""}`))
    .map((c) => c.cat_id)
    .filter((x): x is string => Boolean(x));

  const ordered = Array.from(new Set([...priorityCatIds, ...submissionCats, ...allCatIds])).slice(
    0,
    maxCats,
  );

  const docs: HarvestedCommitteeDoc[] = [];

  await Promise.all(
    ordered.map(async (catId) => {
      try {
        const payload = await fetchLegcoJson<BiCategoryPayload>(`${baseDir}/${catId}.json`, 10000);
        const catEn = stripTags(payload.category?.en);
        const catTc = stripTags(payload.category?.tc);

        for (const group of payload.papers || []) {
          for (const item of group.list || []) {
            const titleEn = stripTags(item.title?.en);
            const titleTc = stripTags(item.title?.tc);
            const urlEn = normalizeLegcoUrl(item.pdf?.en);
            const urlTc = normalizeLegcoUrl(item.pdf?.tc);
            if (!urlEn && !urlTc && !titleEn && !titleTc) continue;

            const paperNo = stripTags(item.paper_no || item.paper_no_display?.en || "");
            const issueEntry = item.date?.find((d) => d.type === "issue") || item.date?.[0];
            const meetEntry = item.date?.find((d) => d.type === "meeting");
            const replyNote = item.note?.find((n) => n.type === "reply");

            const isReply =
              /Administration['’]s\s+response|Responses?\s+to\s+submissions?|當局就意見書?所作回應|政府當局.*回應/i.test(`${titleEn} ${titleTc}`);
            const isSubmission =
              /Submission|Deputation|意見書/i.test(`${titleEn} ${titleTc} ${catEn} ${catTc}`) &&
              !isReply;

            docs.push({
              paperNo,
              docType: isReply ? "reply" : isSubmission ? "submission" : "paper",
              titleEn: titleEn || titleTc || paperNo,
              titleTc: titleTc || titleEn || paperNo,
              urlEn,
              urlTc,
              issueDate: (issueEntry?.value || "").replace(/\./g, "-"),
              meetingDate: (meetEntry?.value || "").replace(/\./g, "-"),
              replyToPaperNo: "",
              relatedPaperNo: stripTags(replyNote?.value),
              categoryEn: catEn,
              categoryTc: catTc,
            });
          }
        }
      } catch {
        // Ignore single category fetch failure
      }
    }),
  );

  // Back-link reply_to_paper_no when a submission lists note.type === "reply"
  const replyParentByReplyPaper = new Map<string, string>();
  for (const d of docs) {
    if (d.docType === "submission" && d.relatedPaperNo && d.paperNo) {
      replyParentByReplyPaper.set(d.relatedPaperNo.toUpperCase(), d.paperNo);
    }
  }
  for (const d of docs) {
    if (d.docType === "reply" && d.paperNo) {
      const parent = replyParentByReplyPaper.get(d.paperNo.toUpperCase());
      if (parent) d.replyToPaperNo = parent;
    }
  }

  return docs;
}
