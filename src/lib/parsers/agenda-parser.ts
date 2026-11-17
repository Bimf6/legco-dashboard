import crypto from "node:crypto";
import * as cheerio from "cheerio";
import { normalizeLegcoUrl } from "../legco-http";

export interface AgendaPaperEntry {
  paperNo: string;
  description: string;
  url: string;
  isToFollow: boolean;
  isRestricted: boolean;
  isSubmissionLink?: boolean;
}

export interface AgendaSubLink {
  label: string;
  url: string;
  catId: string | null;
}

export interface AgendaItem {
  itemNum: string;
  title: string;
  remark: string;
  papers: AgendaPaperEntry[];
  subLinks: AgendaSubLink[];
}

export interface ParsedAgenda {
  isNotFound: boolean;
  hash: string;
  items: AgendaItem[];
  discoveredPdfs: AgendaPaperEntry[];
  papersPortalLinks: AgendaSubLink[];
}

export interface ParsedCouncilQuestion {
  questionNo: number;
  questionType: "oral" | "written";
  subject: string;
  memberName: string;
  replyingOfficial: string;
  body: string;
  contentHash: string;
}

export interface AgendaDiffEvent {
  eventType:
    | "AGENDA_PUBLISHED"
    | "AGENDA_REVISED"
    | "ITEM_ADDED"
    | "ITEM_REVISED"
    | "PAPER_FULFILLED"
    | "PAPER_ADDED_TO_AGENDA";
  severity: "high" | "normal";
  titleEn: string;
  titleTc: string;
  summaryEn: string;
  summaryTc: string;
  oldValue?: string;
  newValue?: string;
  linkUrl?: string;
}

const PAPER_NO_REGEX =
  /(?:LC Paper No\.\s*|立法會\s*|File Ref:\s*)?([A-Z]{1,4}(?:\(\d+\))?\s*\d+\/\d+(?:\(\d+\))?|[A-Z]{2,5}\d+\/\d+|File Ref:\s*[A-Za-z0-9\-\/]+)/i;

function cleanText(raw: string): string {
  return raw.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

export function extractPaperNo(text: string): string {
  const cleaned = cleanText(text);
  const cbMatch = cleaned.match(
    /(?:CB\(\d+\)\d+\/\d+(?:\(\d+\))?|FC\d+\/\d+(?:\(\d+\))?|ESC\d+\/\d+(?:\(\d+\))?|PWSC\d+\/\d+(?:\(\d+\))?|LS\d+\/\d+|IN\d+\/\d+)/i,
  );
  if (cbMatch) return cbMatch[0].toUpperCase();
  const fallback = cleaned.match(PAPER_NO_REGEX);
  return fallback ? cleanText(fallback[1]) : "";
}

export function isLegcoNotFoundHtml(html: string): boolean {
  return (
    html.includes('data-unit="page-not-found"') ||
    html.includes("找不到網頁") ||
    html.includes("Page Not Found")
  );
}

export function parseCommitteeAgendaHtml(html: string): ParsedAgenda {
  if (!html || isLegcoNotFoundHtml(html)) {
    return {
      isNotFound: true,
      hash: "",
      items: [],
      discoveredPdfs: [],
      papersPortalLinks: [],
    };
  }

  const $ = cheerio.load(html);
  const items: AgendaItem[] = [];
  const discoveredPdfs: AgendaPaperEntry[] = [];
  const papersPortalLinks: AgendaSubLink[] = [];
  const seenUrls = new Set<string>();

  const listItems = $('div[data-unit="section.list-item"], div[data-unit^="section.cm-"]');

  listItems.each((_, el) => {
    const node = $(el);
    const itemNum = cleanText(
      node.find('[data-unit="item_num"]').first().text() ||
        node.find('[data-unit="num"]').first().text(),
    );
    const title = cleanText(
      node.find('> [data-unit="title"] [data-unit="text"]').first().text() ||
        node.find('[data-unit="title"]').first().text(),
    );
    const remark = cleanText(node.find('> [data-unit="remark"]').first().text());

    const papers: AgendaPaperEntry[] = [];
    const subLinks: AgendaSubLink[] = [];

    node.find('table[data-unit="paper"] tbody tr, table[data-unit="cm-item"] tbody tr').each((_, tr) => {
      const tds = $(tr).find("td");
      if (tds.length === 0) return;

      const firstCellText = cleanText(tds.eq(0).text());
      const lastCellText =
        tds.length >= 3
          ? cleanText(tds.eq(2).text())
          : tds.length === 2
            ? cleanText(tds.eq(1).text())
            : "";
      const fullRowText = cleanText($(tr).text());

      let href = "";
      $(tr)
        .find("a[href]")
        .each((__, a) => {
          const h = $(a).attr("href") || "";
          if (h && !h.startsWith("#")) {
            href = normalizeLegcoUrl(h);
          }
        });

      const paperNo = extractPaperNo(firstCellText || fullRowText);
      const isToFollow = /\(to follow\)|容後奉上/i.test(fullRowText);
      const isRestricted = /Restricted to members only|只限委員參閱/i.test(fullRowText);
      const description = lastCellText || firstCellText || fullRowText;

      if (!paperNo && !href && !description) return;

      const entry: AgendaPaperEntry = {
        paperNo,
        description,
        url: href,
        isToFollow,
        isRestricted,
      };
      papers.push(entry);

      if (href && href.toLowerCase().includes(".pdf") && !seenUrls.has(href)) {
        seenUrls.add(href);
        discoveredPdfs.push(entry);
      }
    });

    node.find("a[href]").each((_, a) => {
      const rawHref = $(a).attr("href") || "";
      if (!rawHref || rawHref.startsWith("#")) return;
      const fullHref = normalizeLegcoUrl(rawHref);
      const label = cleanText($(a).text());

      if (fullHref.includes("#papers-and-reports")) {
        const catMatch = fullHref.match(/cat=([a-z0-9_.-]+)/i);
        const subLink: AgendaSubLink = {
          label: label || "Papers & Submissions",
          url: fullHref,
          catId: catMatch ? catMatch[1] : null,
        };
        subLinks.push(subLink);
        papersPortalLinks.push(subLink);
      } else if (fullHref.toLowerCase().endsWith(".pdf") && !seenUrls.has(fullHref)) {
        seenUrls.add(fullHref);
        discoveredPdfs.push({
          paperNo: extractPaperNo(label),
          description: label || title,
          url: fullHref,
          isToFollow: false,
          isRestricted: false,
        });
      }
    });

    if (itemNum || title || papers.length > 0 || subLinks.length > 0) {
      items.push({ itemNum, title, remark, papers, subLinks });
    }
  });

  const normalizedForHash = JSON.stringify(
    items.map((it) => ({
      n: it.itemNum,
      t: it.title,
      p: it.papers.map((p) => `${p.paperNo}|${p.url}|${p.isToFollow ? 1 : 0}|${p.description}`),
      s: it.subLinks.map((s) => s.url),
    })),
  );
  const hash = crypto.createHash("sha256").update(normalizedForHash).digest("hex").slice(0, 16);

  return {
    isNotFound: false,
    hash,
    items,
    discoveredPdfs,
    papersPortalLinks,
  };
}

export function parseCouncilQuestionsFromAgenda(html: string): ParsedCouncilQuestion[] {
  if (!html || isLegcoNotFoundHtml(html)) return [];

  const $ = cheerio.load(html);
  const results: ParsedCouncilQuestion[] = [];

  const officialByNum = new Map<number, string>();
  $('div[data-unit="section.cm-question"] tbody tr').each((_, tr) => {
    const tds = $(tr).find("td");
    if (tds.length >= 4) {
      const numMatch = cleanText(tds.eq(0).text()).match(/^(\d+)/);
      if (numMatch) {
        officialByNum.set(Number(numMatch[1]), cleanText(tds.eq(3).text()));
      }
    }
  });

  $('a[name^="q_"]').each((_, anchor) => {
    const nameAttr = $(anchor).attr("name") || "";
    const numMatch = nameAttr.match(/^q_(\d+)$/);
    if (!numMatch) return;
    const questionNo = Number(numMatch[1]);

    const headerDiv = $(anchor).next("div");
    const memberDiv = headerDiv.next("div");
    const detailsDiv = memberDiv.next('div[data-unit="question-details"]');

    const headerHtml = headerDiv.html() || "";
    const headerLines = headerHtml
      .split(/<br\s*\/?>/i)
      .map((part) => cleanText(cheerio.load(part).text()))
      .filter((line) => line.length > 0 && !/^\(Translation\)$/i.test(line));

    const headerJoined = headerLines.join(" ");
    const isOral = /For oral reply|口頭答覆/i.test(headerJoined);
    const isWritten = /For written reply|書面答覆/i.test(headerJoined);
    const questionType: "oral" | "written" = isWritten && !isOral ? "written" : "oral";

    const subject =
      headerLines.find(
        (line) =>
          !/^Question\s+\d+$/i.test(line) &&
          !/^第\d+項質詢$/i.test(line) &&
          !/For (oral|written) reply/i.test(line) &&
          !/[（(]?(?:口頭|書面)答覆[）)]?/.test(line),
      ) || headerJoined;

    const rawMember = cleanText(memberDiv.text())
      .replace(/\s*to ask:\s*$/i, "")
      .replace(/議員問：\s*$/, "議員")
      .replace(/問：\s*$/, "")
      .trim();

    const body = cleanText(detailsDiv.text());
    const replyingOfficial = officialByNum.get(questionNo) || "";

    const contentHash = crypto
      .createHash("sha256")
      .update(`${questionNo}|${questionType}|${rawMember}|${subject}|${body}`)
      .digest("hex")
      .slice(0, 16);

    results.push({
      questionNo,
      questionType,
      subject,
      memberName: rawMember,
      replyingOfficial,
      body,
      contentHash,
    });
  });

  return results;
}

export function diffAgendaItems(
  prevItems: AgendaItem[],
  nextItems: AgendaItem[],
  meetingSubjectEn: string,
  meetingSubjectTc: string,
  agendaUrl: string,
): AgendaDiffEvent[] {
  const events: AgendaDiffEvent[] = [];
  const prevByNum = new Map<string, AgendaItem>();
  for (const item of prevItems) {
    prevByNum.set(`${item.itemNum}|${item.title}`.toLowerCase(), item);
  }

  const prevPaperMap = new Map<string, AgendaPaperEntry>();
  for (const item of prevItems) {
    for (const p of item.papers) {
      const key = (p.paperNo || p.description || p.url).toLowerCase();
      if (key) prevPaperMap.set(key, p);
    }
  }

  let fulfilledCount = 0;
  const fulfilledLabels: string[] = [];
  let newPaperCount = 0;
  const newPaperLabels: string[] = [];
  let addedItemCount = 0;
  const addedItemTitles: string[] = [];

  for (const item of nextItems) {
    const itemKey = `${item.itemNum}|${item.title}`.toLowerCase();
    if (!prevByNum.has(itemKey) && prevItems.length > 0) {
      const titleMatchOnly = prevItems.some(
        (old) => old.itemNum === item.itemNum && old.itemNum !== "",
      );
      if (!titleMatchOnly) {
        addedItemCount += 1;
        addedItemTitles.push(`${item.itemNum} ${item.title}`.trim());
      }
    }

    for (const p of item.papers) {
      const key = (p.paperNo || p.description || p.url).toLowerCase();
      if (!key) continue;
      const oldPaper = prevPaperMap.get(key);
      if (oldPaper && oldPaper.isToFollow && !p.isToFollow && p.url) {
        fulfilledCount += 1;
        fulfilledLabels.push(p.paperNo || p.description);
      } else if (!oldPaper && p.url) {
        newPaperCount += 1;
        newPaperLabels.push(p.paperNo || p.description);
      }
    }
  }

  if (fulfilledCount > 0) {
    const sample = fulfilledLabels.slice(0, 3).join(", ");
    events.push({
      eventType: "PAPER_FULFILLED",
      severity: "high",
      titleEn: `Agenda "(to follow)" paper uploaded — ${meetingSubjectEn}`,
      titleTc: `議程「容後奉上」文件已上載 — ${meetingSubjectTc}`,
      summaryEn: `${fulfilledCount} pending paper(s) now have live PDF links: ${sample}`,
      summaryTc: `${fulfilledCount} 份待上載文件已補上連結：${sample}`,
      linkUrl: agendaUrl,
    });
  }

  if (newPaperCount > 0) {
    const sample = newPaperLabels.slice(0, 3).join(", ");
    events.push({
      eventType: "PAPER_ADDED_TO_AGENDA",
      severity: "high",
      titleEn: `New paper(s) added to agenda — ${meetingSubjectEn}`,
      titleTc: `議程新增文件 — ${meetingSubjectTc}`,
      summaryEn: `${newPaperCount} new paper link(s) added inside agenda: ${sample}`,
      summaryTc: `議程內新增 ${newPaperCount} 份文件連結：${sample}`,
      linkUrl: agendaUrl,
    });
  }

  if (addedItemCount > 0) {
    const sample = addedItemTitles.slice(0, 2).join(" / ");
    events.push({
      eventType: "ITEM_ADDED",
      severity: "high",
      titleEn: `Agenda items updated — ${meetingSubjectEn}`,
      titleTc: `議程項目更新 — ${meetingSubjectTc}`,
      summaryEn: `Added or changed item(s): ${sample}`,
      summaryTc: `新增或修訂議程項目：${sample}`,
      linkUrl: agendaUrl,
    });
  }

  return events;
}
