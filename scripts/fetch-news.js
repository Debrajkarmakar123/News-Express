import fs from "fs";
import path from "path";
import Parser from "rss-parser";
import { GoogleGenAI } from "@google/genai";

const ROOT = process.cwd();
const NEWS_FILE = path.join(ROOT, "news.json");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  throw new Error("GEMINI_API_KEY is missing.");
}

const ai = new GoogleGenAI({
  apiKey: GEMINI_API_KEY
});

const parser = new Parser({
  timeout: 20000
});

const MODEL = "gemini-2.5-flash-lite";

const MAX_HOME_NEWS = 10;
const MAX_CANDIDATES = 35;

// News older than this will not be considered for new publishing.
const MAX_NEWS_AGE_HOURS = 48;

const FEEDS = [
  {
    category: "India",
    url: "https://news.google.com/rss/search?q=India+when:2d&hl=en-IN&gl=IN&ceid=IN:en"
  },
  {
    category: "Technology",
    url: "https://news.google.com/rss/search?q=Technology+when:2d&hl=en-IN&gl=IN&ceid=IN:en"
  },
  {
    category: "Sports",
    url: "https://news.google.com/rss/search?q=Sports+when:2d&hl=en-IN&gl=IN&ceid=IN:en"
  },
  {
    category: "Entertainment",
    url: "https://news.google.com/rss/search?q=Entertainment+when:2d&hl=en-IN&gl=IN&ceid=IN:en"
  },
  {
    category: "India News",
    url: "https://news.google.com/rss/search?q=India+News+when:2d&hl=en-IN&gl=IN&ceid=IN:en"
  }
];

function loadNews() {
  if (!fs.existsSync(NEWS_FILE)) {
    return [];
  }

  try {
    const data = JSON.parse(fs.readFileSync(NEWS_FILE, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch (error) {
    console.error("Could not read news.json:", error.message);
    return [];
  }
}

function saveNews(news) {
  fs.writeFileSync(
    NEWS_FILE,
    JSON.stringify(news, null, 2),
    "utf8"
  );
}

function cleanText(text = "") {
  return String(text)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTitle(title = "") {
  return cleanText(title)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeUrl(url = "") {
  try {
    const u = new URL(url);

    u.hash = "";

    const removeParams = [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "gclid",
      "fbclid"
    ];

    removeParams.forEach((param) => {
      u.searchParams.delete(param);
    });

    return u.toString();
  } catch {
    return String(url).trim();
  }
}

function createId() {
  return `${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

function createSlug(text = "") {
  return cleanText(text)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 90);
}

function hoursAgo(date) {
  const time = new Date(date).getTime();

  if (!Number.isFinite(time)) {
    return 999999;
  }

  return (Date.now() - time) / (1000 * 60 * 60);
}

function similarity(a, b) {
  const wordsA = new Set(
    normalizeTitle(a)
      .split(" ")
      .filter((word) => word.length > 3)
  );

  const wordsB = new Set(
    normalizeTitle(b)
      .split(" ")
      .filter((word) => word.length > 3)
  );

  if (!wordsA.size || !wordsB.size) {
    return 0;
  }

  let common = 0;

  for (const word of wordsA) {
    if (wordsB.has(word)) {
      common++;
    }
  }

  return common / Math.max(wordsA.size, wordsB.size);
}

function deduplicateArticles(items) {
  const result = [];
  const seenUrls = new Set();

  for (const item of items) {
    const normalizedUrl = normalizeUrl(item.url);

    if (!normalizedUrl) {
      continue;
    }

    if (seenUrls.has(normalizedUrl)) {
      continue;
    }

    const duplicateTitle = result.find(
      (existing) =>
        similarity(existing.title, item.title) >= 0.72
    );

    if (duplicateTitle) {
      continue;
    }

    seenUrls.add(normalizedUrl);

    result.push({
      ...item,
      url: normalizedUrl
    });
  }

  return result;
}

async function fetchFeed(feed) {
  try {
    console.log(`Fetching: ${feed.category}`);

    const result = await parser.parseURL(feed.url);

    return result.items.map((item) => ({
      title: cleanText(item.title || ""),
      description: cleanText(
        item.contentSnippet ||
        item.content ||
        item.summary ||
        ""
      ),
      url: normalizeUrl(item.link || ""),
      publishedAt:
        item.isoDate ||
        item.pubDate ||
        new Date().toISOString(),
      feedCategory: feed.category
    }));
  } catch (error) {
    console.error(
      `Feed failed (${feed.category}):`,
      error.message
    );

    return [];
  }
}

async function getAllCandidates() {
  const results = await Promise.all(
    FEEDS.map(fetchFeed)
  );

  const all = results.flat();

  const fresh = all.filter((article) => {
    return (
      article.title &&
      article.url &&
      hoursAgo(article.publishedAt) <= MAX_NEWS_AGE_HOURS
    );
  });

  fresh.sort(
    (a, b) =>
      new Date(b.publishedAt) -
      new Date(a.publishedAt)
  );

  return deduplicateArticles(fresh).slice(
    0,
    MAX_CANDIDATES
  );
}

async function selectBestNews(candidates, oldNews) {
  if (!candidates.length) {
    return [];
  }

  const oldUrls = new Set(
    oldNews.map((item) => normalizeUrl(item.url))
  );

  const newCandidates = candidates.filter(
    (item) => !oldUrls.has(normalizeUrl(item.url))
  );

  if (!newCandidates.length) {
    return [];
  }

  const compactCandidates = newCandidates.map(
    (item, index) => ({
      index,
      title: item.title,
      description: item.description.slice(0, 500),
      category: item.feedCategory,
      publishedAt: item.publishedAt
    })
  );

  const schema = {
    type: "object",
    properties: {
      selected: {
        type: "array",
        items: {
          type: "object",
          properties: {
            index: {
              type: "integer"
            },
            score: {
              type: "integer"
            },
            reason: {
              type: "string"
            }
          },
          required: [
            "index",
            "score",
            "reason"
          ]
        }
      }
    },
    required: ["selected"]
  };

  const prompt = `
You are the editorial selection system for a legitimate news website.

Select the most important and genuinely newsworthy stories from the candidate list.

Rules:
- Select at most ${MAX_HOME_NEWS} stories.
- Prefer recent, significant, useful, widely relevant stories.
- Prefer stories with enough factual information to write a detailed article.
- Avoid duplicate or near-duplicate stories.
- Do not select rumors, obvious clickbait, fabricated claims, or unsupported social-media claims.
- Do not invent facts.
- Do not select stories only because their title sounds sensational.
- Score each selected story from 1 to 100.
- Return ONLY valid JSON matching the requested schema.

Candidates:
${JSON.stringify(compactCandidates, null, 2)}
`;

  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: schema
      }
    });

    const parsed = JSON.parse(response.text || "{}");

    const selected = Array.isArray(parsed.selected)
      ? parsed.selected
      : [];

    return selected
      .filter(
        (item) =>
          Number.isInteger(item.index) &&
          item.index >= 0 &&
          item.index < newCandidates.length
      )
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_HOME_NEWS)
      .map((item) => ({
        ...newCandidates[item.index],
        editorialScore: item.score
      }));
  } catch (error) {
    console.error(
      "Gemini selection failed:",
      error.message
    );

    // Safe fallback: use newest candidates.
    return newCandidates
      .slice(0, MAX_HOME_NEWS)
      .map((item) => ({
        ...item,
        editorialScore: 50
      }));
  }
}

async function generateArticle(article) {
  const schema = {
    type: "object",
    properties: {
      headline: {
        type: "string"
      },
      summary: {
        type: "string"
      },
      article: {
        type: "string"
      },
      category: {
        type: "string"
      },
      tags: {
        type: "array",
        items: {
          type: "string"
        }
      },
      keyPoints: {
        type: "array",
        items: {
          type: "string"
        }
      }
    },
    required: [
      "headline",
      "summary",
      "article",
      "category",
      "tags",
      "keyPoints"
    ]
  };

  const prompt = `
You are a professional digital news writer.

Create a completely ORIGINAL and detailed news article using ONLY the factual information contained in the supplied news data.

IMPORTANT RULES:

1. Do NOT copy sentences or paragraphs from the source.
2. Do NOT imitate the source article's wording.
3. Write the article completely in your own words.
4. Do NOT invent names, numbers, quotes, dates, locations, events, causes, reactions, or future developments.
5. If a fact is not present in the supplied data, do not claim it as fact.
6. Do not create fake quotations.
7. Do not present speculation as confirmed information.
8. The article should be informative and neutral.
9. Target approximately 800–1200 words when the supplied facts support that much detail.
10. If the available facts are insufficient, write a shorter article rather than filling space with invented information.
11. Use clear section headings inside the article.
12. Explain the event, its context, why it matters, and confirmed developments when supported by the supplied information.
13. Avoid sensational clickbait.
14. The headline must be original.
15. The summary should be around 2–4 sentences.
16. The article field should contain plain text with section headings separated by blank lines.
17. Do not include HTML tags.
18. Do not include the source name or source URL inside the article.

News data:

Title:
${article.title}

Description:
${article.description}

Category:
${article.feedCategory}

Published time:
${article.publishedAt}

Return only JSON matching the schema.
`;

  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: schema
      }
    });

    const result = JSON.parse(response.text || "{}");

    if (
      !result.headline ||
      !result.summary ||
      !result.article
    ) {
      throw new Error("Gemini returned incomplete article.");
    }

    return result;
  } catch (error) {
    console.error(
      `Article generation failed for "${article.title}":`,
      error.message
    );

    return {
      headline: article.title,
      summary:
        article.description ||
        "This news story is currently being updated.",
      article:
        article.description ||
        "Detailed information is currently unavailable.",
      category: article.feedCategory || "Other",
      tags: [],
      keyPoints: []
    };
  }
}

function buildNewsObject(source, generated) {
  const headline =
    cleanText(generated.headline) ||
    source.title;

  return {
    id: createId(),
    slug: `${createSlug(headline)}-${Date.now()
      .toString()
      .slice(-6)}`,

    headline,

    summary:
      cleanText(generated.summary) ||
      source.description,

    article:
      cleanText(generated.article) ||
      source.description,

    category:
      cleanText(generated.category) ||
      source.feedCategory ||
      "Other",

    tags: Array.isArray(generated.tags)
      ? generated.tags
          .map((tag) => cleanText(tag))
          .filter(Boolean)
          .slice(0, 8)
      : [],

    keyPoints: Array.isArray(generated.keyPoints)
      ? generated.keyPoints
          .map((point) => cleanText(point))
          .filter(Boolean)
          .slice(0, 6)
      : [],

    publishedAt: source.publishedAt,

    addedAt: new Date().toISOString(),

    editorialScore:
      Number(source.editorialScore) || 50,

    // Kept internally for duplicate checking.
    // Frontend will NOT display it.
    url: source.url
  };
}

async function main() {
  console.log("=================================");
  console.log("       NEWS-EXPRESS UPDATE");
  console.log("=================================");

  const oldNews = loadNews();

  console.log(
    `Existing archive: ${oldNews.length} articles`
  );

  const candidates = await getAllCandidates();

  console.log(
    `Fresh candidates: ${candidates.length}`
  );

  if (!candidates.length) {
    console.log("No fresh candidates found.");
    return;
  }

  const selected = await selectBestNews(
    candidates,
    oldNews
  );

  console.log(
    `Selected for publication: ${selected.length}`
  );

  const newArticles = [];

  for (const item of selected) {
    console.log(
      `Generating article: ${item.title}`
    );

    const generated =
      await generateArticle(item);

    const finalArticle = buildNewsObject(
      item,
      generated
    );

    newArticles.push(finalArticle);

    // Small delay to reduce request bursts.
    await new Promise((resolve) =>
      setTimeout(resolve, 1500)
    );
  }

  const archive = [
    ...newArticles,
    ...oldNews
  ];

  const uniqueArchive = [];
  const seenUrls = new Set();

  for (const item of archive) {
    const url = normalizeUrl(item.url);

    if (url && !seenUrls.has(url)) {
      seenUrls.add(url);
      uniqueArchive.push(item);
    }
  }

  uniqueArchive.sort(
    (a, b) =>
      new Date(b.publishedAt) -
      new Date(a.publishedAt)
  );

  saveNews(uniqueArchive);

  console.log(
    `Added ${newArticles.length} new articles.`
  );

  console.log(
    `Total permanent archive: ${uniqueArchive.length}`
  );

  console.log("Update completed successfully.");
}

main().catch((error) => {
  console.error("UPDATE FAILED:", error);
  process.exit(1);
});
