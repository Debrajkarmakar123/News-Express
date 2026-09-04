````js
import fs from "fs";
import Parser from "rss-parser";
import { GoogleGenAI } from "@google/genai";

const parser = new Parser({
  timeout: 15000
});

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

const NEWS_FILE = "./news.json";

// RSS feeds
const FEEDS = [
  {
    name: "Google News",
    url: "https://news.google.com/rss?hl=en-IN&gl=IN&ceid=IN:en"
  },
  {
    name: "Google News India",
    url: "https://news.google.com/rss/search?q=India&hl=en-IN&gl=IN&ceid=IN:en"
  },
  {
    name: "Google News Technology",
    url: "https://news.google.com/rss/search?q=technology&hl=en-IN&gl=IN&ceid=IN:en"
  },
  {
    name: "Google News Sports",
    url: "https://news.google.com/rss/search?q=sports&hl=en-IN&gl=IN&ceid=IN:en"
  },
  {
    name: "Google News Entertainment",
    url: "https://news.google.com/rss/search?q=entertainment&hl=en-IN&gl=IN&ceid=IN:en"
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
    console.log("Could not read news.json:", error.message);
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

function normalizeUrl(url) {
  try {
    const u = new URL(url);

    u.hash = "";

    // Remove common tracking parameters
    [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "gclid",
      "fbclid"
    ].forEach(param => {
      u.searchParams.delete(param);
    });

    return u.toString().replace(/\/$/, "");
  } catch {
    return String(url || "").trim();
  }
}

function cleanText(text = "") {
  return String(text)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/*
  Converts a headline into a URL-friendly slug.

  Example:
  "India Announces Major New Policy 2026!"
  =>
  "india-announces-major-new-policy-2026"
*/
function createSlug(text = "") {
  let slug = cleanText(text)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  if (!slug) {
    slug = "news";
  }

  return slug.slice(0, 120).replace(/-$/, "");
}

function createUniqueSlug(text, usedSlugs) {
  const base = createSlug(text);

  let slug = base;
  let counter = 2;

  while (usedSlugs.has(slug)) {
    slug = `${base}-${counter}`;
    counter++;
  }

  usedSlugs.add(slug);

  return slug;
}

/*
  Old articles may not have a slug because they were created
  before slug support was added.

  This function gives those old articles stable slugs too.
*/
function migrateOldSlugs(news) {
  const usedSlugs = new Set();

  // First preserve already existing slugs
  for (const article of news) {
    if (article.slug) {
      usedSlugs.add(article.slug);
    }
  }

  // Then generate missing slugs
  return news.map(article => {
    if (article.slug) {
      return article;
    }

    const sourceText =
      article.headline ||
      article.originalTitle ||
      article.title ||
      "news";

    return {
      ...article,
      slug: createUniqueSlug(sourceText, usedSlugs)
    };
  });
}

function hoursOld(date) {
  const time = new Date(date).getTime();

  if (!Number.isFinite(time)) {
    return 9999;
  }

  return Math.max(
    0,
    (Date.now() - time) / (1000 * 60 * 60)
  );
}

function recencyScore(date) {
  const hours = hoursOld(date);

  if (hours <= 1) return 100;
  if (hours <= 3) return 90;
  if (hours <= 6) return 80;
  if (hours <= 12) return 70;
  if (hours <= 24) return 60;
  if (hours <= 48) return 40;
  if (hours <= 72) return 20;

  return 5;
}

async function fetchFeeds() {
  const articles = [];

  for (const feed of FEEDS) {
    try {
      console.log(`Fetching: ${feed.name}`);

      const result = await parser.parseURL(feed.url);

      for (const item of result.items || []) {
        if (!item.link || !item.title) {
          continue;
        }

        articles.push({
          title: cleanText(item.title),
          url: normalizeUrl(item.link),
          source: feed.name,
          publishedAt:
            item.isoDate ||
            item.pubDate ||
            new Date().toISOString(),
          description: cleanText(
            item.contentSnippet ||
            item.content ||
            item.summary ||
            ""
          )
        });
      }
    } catch (error) {
      console.log(
        `Feed failed: ${feed.name}`,
        error.message
      );
    }
  }

  return articles;
}

function groupSimilarStories(articles) {
  const groups = new Map();

  for (const article of articles) {
    const key = article.title
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .replace(/\s+/g, " ")
      .split(" ")
      .slice(0, 8)
      .join(" ");

    if (!groups.has(key)) {
      groups.set(key, []);
    }

    groups.get(key).push(article);
  }

  return groups;
}

async function aiAnalyze(article) {
  const prompt = `
You are a professional news editor.

Analyze the following news item.

Title:
${article.title}

Description:
${article.description}

Source:
${article.source}

Return ONLY valid JSON.

Required JSON format:
{
  "headline": "short accurate headline",
  "summary": "2-3 sentence factual summary",
  "category": "one of: India, World, Technology, Business, Sports, Entertainment, Science, Other",
  "tags": ["tag1", "tag2", "tag3"],
  "importance": 5
}

Rules:
- Do not invent facts.
- Do not add information that is not supported by the title or description.
- Keep the summary factual.
- importance must be an integer from 1 to 10.
- headline must accurately represent the supplied news.
`;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-lite",
      contents: prompt,
      config: {
        responseMimeType: "application/json"
      }
    });

    const text = response.text.trim();

    const cleaned = text
      .replace(/^```json/i, "")
      .replace(/^```/i, "")
      .replace(/```$/i, "")
      .trim();

    const result = JSON.parse(cleaned);

    return {
      headline:
        cleanText(result.headline) ||
        article.title,

      summary:
        cleanText(result.summary) ||
        article.description ||
        article.title,

      category:
        cleanText(result.category) ||
        "Other",

      tags:
        Array.isArray(result.tags)
          ? result.tags
              .map(tag => cleanText(tag))
              .filter(Boolean)
              .slice(0, 5)
          : [],

      importance:
        Number.isInteger(result.importance)
          ? Math.min(Math.max(result.importance, 1), 10)
          : 5
    };
  } catch (error) {
    console.log(
      "Gemini analysis failed:",
      error.message
    );

    // Safe fallback when AI fails
    return {
      headline: article.title,
      summary:
        article.description ||
        article.title,
      category: "Other",
      tags: [],
      importance: 5
    };
  }
}

function calculateTrendingScore({
  article,
  sourceCount,
  importance
}) {
  const recent = recencyScore(article.publishedAt);

  const sourceScore = Math.min(
    sourceCount * 10,
    40
  );

  const importanceScore =
    Math.min(importance, 10) * 5;

  return Math.round(
    recent +
    sourceScore +
    importanceScore
  );
}

async function main() {
  console.log("Starting News-Express updater...");

  let oldNews = loadNews();

  console.log(
    `Existing archive: ${oldNews.length} articles`
  );

  // Add slugs to old articles that don't have one
  oldNews = migrateOldSlugs(oldNews);

  const fetched = await fetchFeeds();

  console.log(
    `Fetched: ${fetched.length} articles`
  );

  // Remove duplicate URLs from current fetch
  const unique = new Map();

  for (const article of fetched) {
    if (!unique.has(article.url)) {
      unique.set(article.url, article);
    }
  }

  const articles = [...unique.values()];

  console.log(
    `Unique fetched articles: ${articles.length}`
  );

  // Group similar stories
  const groups = groupSimilarStories(articles);

  const newArticles = [];

  // Keep all existing slugs reserved
  const usedSlugs = new Set(
    oldNews
      .map(item => item.slug)
      .filter(Boolean)
  );

  for (const [, group] of groups) {
    const primary = group[0];

    // URL-based permanent duplicate check
    const alreadyExists = oldNews.some(
      item =>
        normalizeUrl(item.url) ===
        normalizeUrl(primary.url)
    );

    if (alreadyExists) {
      continue;
    }

    console.log(
      `Analyzing: ${primary.title}`
    );

    const aiResult = await aiAnalyze(primary);

    const sourceCount = group.length;

    const trendingScore =
      calculateTrendingScore({
        article: primary,
        sourceCount,
        importance: aiResult.importance
      });

    /*
      Slug is based on the final AI headline.
      If two articles have the same headline,
      -2, -3, etc. is automatically added.
    */
    const slug = createUniqueSlug(
      aiResult.headline || primary.title,
      usedSlugs
    );

    newArticles.push({
      id:
        `${Date.now()}-` +
        Math.random()
          .toString(36)
          .slice(2, 8),

      slug,

      headline: aiResult.headline,

      originalTitle: primary.title,

      summary: aiResult.summary,

      category: aiResult.category,

      tags: aiResult.tags,

      source: primary.source,

      sourceCount,

      url: primary.url,

      publishedAt: primary.publishedAt,

      addedAt: new Date().toISOString(),

      importance: aiResult.importance,

      trendingScore,

      trending:
        trendingScore >= 100
    });
  }

  // Permanent archive:
  // NEW + OLD
  const archive = [
    ...newArticles,
    ...oldNews
  ];

  // Latest published news first
  archive.sort((a, b) => {
    const dateA = new Date(a.publishedAt).getTime();
    const dateB = new Date(b.publishedAt).getTime();

    return (
      (Number.isFinite(dateB) ? dateB : 0) -
      (Number.isFinite(dateA) ? dateA : 0)
    );
  });

  saveNews(archive);

  console.log(
    `Added ${newArticles.length} new articles`
  );

  console.log(
    `Permanent archive now contains ${archive.length} articles`
  );

  console.log("Done.");
}

main().catch(error => {
  console.error("Updater failed:", error);
  process.exit(1);
});
````
