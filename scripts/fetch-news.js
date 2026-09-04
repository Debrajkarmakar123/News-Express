
import fs from "fs";
import Parser from "rss-parser";
import { GoogleGenAI } from "@google/genai";

const parser = new Parser();

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

const NEWS_FILE = "./news.json";

const FEEDS = [
  {
    name: "Google News",
    url: "https://news.google.com/rss?hl=en-IN&gl=IN&ceid=IN:en"
  },
  {
    name: "India News",
    url: "https://news.google.com/rss/search?q=India&hl=en-IN&gl=IN&ceid=IN:en"
  },
  {
    name: "Technology",
    url: "https://news.google.com/rss/search?q=technology&hl=en-IN&gl=IN&ceid=IN:en"
  },
  {
    name: "Sports",
    url: "https://news.google.com/rss/search?q=sports&hl=en-IN&gl=IN&ceid=IN:en"
  },
  {
    name: "Entertainment",
    url: "https://news.google.com/rss/search?q=entertainment&hl=en-IN&gl=IN&ceid=IN:en"
  }
];

function loadNews() {
  if (!fs.existsSync(NEWS_FILE)) {
    return [];
  }

  try {
    const data = JSON.parse(
      fs.readFileSync(NEWS_FILE, "utf8")
    );

    return Array.isArray(data) ? data : [];
  } catch {
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
  return text
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeUrl(url = "") {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
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
You are a professional Indian news editor.

Analyze this news item.

Title:
${article.title}

Description:
${article.description}

Source:
${article.source}

Return ONLY valid JSON.

Use exactly this structure:

{
  "headline": "short accurate headline",
  "summary": "2-3 sentence factual summary",
  "category": "India",
  "tags": ["tag1", "tag2", "tag3"],
  "importance": 5
}

Category must be exactly one of:
India, World, Technology, Business, Sports, Entertainment, Science, Other

Rules:
- Do not invent facts.
- Do not add information that is not supported by the title or description.
- Keep the summary factual.
- importance must be an integer from 1 to 10.
`;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-lite",
      contents: prompt,
      config: {
        responseMimeType: "application/json"
      }
    });

    const text = response.text?.trim();

    if (!text) {
      throw new Error("Gemini returned an empty response");
    }

    const cleaned = text
      .replace(/^```json/i, "")
      .replace(/^```/i, "")
      .replace(/```$/i, "")
      .trim();

    return JSON.parse(cleaned);

  } catch (error) {
    console.log(
      "Gemini analysis failed:",
      error.message
    );

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
  const recent = recencyScore(
    article.publishedAt
  );

  const sourceScore = Math.min(
    sourceCount * 10,
    40
  );

  const importanceScore =
    Math.min(
      Number(importance) || 5,
      10
    ) * 5;

  return Math.round(
    recent +
    sourceScore +
    importanceScore
  );
}

async function main() {
  console.log(
    "Starting News-Express updater..."
  );

  if (!process.env.GEMINI_API_KEY) {
    throw new Error(
      "GEMINI_API_KEY is missing from GitHub Secrets."
    );
  }

  const oldNews = loadNews();

  console.log(
    `Existing archive: ${oldNews.length} articles`
  );

  const fetched = await fetchFeeds();

  console.log(
    `Fetched: ${fetched.length} articles`
  );

  const unique = new Map();

  for (const article of fetched) {
    if (!unique.has(article.url)) {
      unique.set(article.url, article);
    }
  }

  const articles = [...unique.values()];

  const groups = groupSimilarStories(
    articles
  );

  const newArticles = [];

  for (const [, group] of groups) {
    const primary = group[0];

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

    const aiResult =
      await aiAnalyze(primary);

    const sourceCount = group.length;

    const trendingScore =
      calculateTrendingScore({
        article: primary,
        sourceCount,
        importance: aiResult.importance
      });

    newArticles.push({
      id:
        `${Date.now()}-` +
        Math.random()
          .toString(36)
          .slice(2, 8),

      headline:
        aiResult.headline ||
        primary.title,

      originalTitle:
        primary.title,

      summary:
        aiResult.summary ||
        primary.description ||
        primary.title,

      category:
        aiResult.category ||
        "Other",

      tags:
        Array.isArray(aiResult.tags)
          ? aiResult.tags
          : [],

      source:
        primary.source,

      sourceCount,

      url:
        primary.url,

      publishedAt:
        primary.publishedAt,

      addedAt:
        new Date().toISOString(),

      importance:
        Number(aiResult.importance) || 5,

      trendingScore,

      trending:
        trendingScore >= 100
    });
  }

  const archive = [
    ...newArticles,
    ...oldNews
  ];

  const finalMap = new Map();

  for (const article of archive) {
    const url = normalizeUrl(article.url);

    if (!url) {
      continue;
    }

    if (!finalMap.has(url)) {
      finalMap.set(url, article);
    }
  }

  const finalArchive =
    [...finalMap.values()];

  finalArchive.sort(
    (a, b) =>
      new Date(b.publishedAt || 0) -
      new Date(a.publishedAt || 0)
  );

  saveNews(finalArchive);

  console.log(
    `Added ${newArticles.length} new articles`
  );

  console.log(
    `Permanent archive now contains ${finalArchive.length} articles`
  );

  console.log("Done.");
}

main().catch(error => {
  console.error(
    "News update failed:",
    error
  );

  process.exit(1);
});

