```js
import fs from "fs";
import Parser from "rss-parser";
import { GoogleGenAI } from "@google/genai";

const parser = new Parser();

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

const NEWS_FILE = "./news.json";

const FEEDS = [
  "https://news.google.com/rss?hl=en-IN&gl=IN&ceid=IN:en",
  "https://news.google.com/rss/search?q=India&hl=en-IN&gl=IN&ceid=IN:en",
  "https://news.google.com/rss/search?q=technology&hl=en-IN&gl=IN&ceid=IN:en",
  "https://news.google.com/rss/search?q=sports&hl=en-IN&gl=IN&ceid=IN:en",
  "https://news.google.com/rss/search?q=entertainment&hl=en-IN&gl=IN&ceid=IN:en"
];

const MAX_AI_ARTICLES = 20;

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
    return u.toString();
  } catch {
    return url;
  }
}

function getCategory(title = "") {
  const t = title.toLowerCase();

  if (/sport|cricket|football|tennis|ipl|olympic/.test(t)) return "Sports";
  if (/tech|ai|iphone|google|microsoft|software|computer|cyber/.test(t))
    return "Technology";
  if (/movie|film|actor|actress|bollywood|hollywood|music|entertainment/.test(t))
    return "Entertainment";

  return "India";
}

function getRecencyScore(date) {
  const published = new Date(date).getTime();

  if (!published) return 20;

  const hours = (Date.now() - published) / (1000 * 60 * 60);

  if (hours <= 1) return 100;
  if (hours <= 3) return 90;
  if (hours <= 6) return 80;
  if (hours <= 12) return 65;
  if (hours <= 24) return 50;
  if (hours <= 48) return 30;

  return 10;
}

async function analyzeWithGemini(article) {
  const prompt = `
You are an Indian news editor.

Analyze this news item and return ONLY valid JSON.

Title:
${article.title}

Description:
${article.description}

Source:
${article.source}

Return exactly this structure:

{
  "summary": "A short factual summary in 1-2 sentences.",
  "importance": 1,
  "category": "India"
}

Rules:
- Do not invent facts.
- importance must be an integer from 1 to 10.
- category must be one of:
  India, Technology, Sports, Entertainment
- Keep the summary concise.
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
      throw new Error("Gemini returned empty response");
    }

    return JSON.parse(text);
  } catch (error) {
    console.log("Gemini error:", error.message);

    return {
      summary: article.description || article.title,
      importance: 5,
      category: getCategory(article.title)
    };
  }
}

async function main() {
  console.log("🚀 News Express update started...");

  let oldNews = [];

  if (fs.existsSync(NEWS_FILE)) {
    try {
      oldNews = JSON.parse(fs.readFileSync(NEWS_FILE, "utf8"));

      if (!Array.isArray(oldNews)) {
        oldNews = [];
      }
    } catch {
      oldNews = [];
    }
  }

  const oldUrls = new Set(
    oldNews.map(item => normalizeUrl(item.url)).filter(Boolean)
  );

  let allArticles = [];

  for (const feedUrl of FEEDS) {
    try {
      console.log("Reading:", feedUrl);

      const feed = await parser.parseURL(feedUrl);

      for (const item of feed.items || []) {
        const url = normalizeUrl(item.link);

        if (!url) continue;

        allArticles.push({
          title: cleanText(item.title || "Untitled"),
          description: cleanText(
            item.contentSnippet ||
            item.content ||
            item.summary ||
            ""
          ),
          url,
          source:
            feed.title ||
            item.creator ||
            "News Source",
          publishedAt:
            item.isoDate ||
            item.pubDate ||
            new Date().toISOString()
        });
      }
    } catch (error) {
      console.log("Feed failed:", error.message);
    }
  }

  // Remove duplicate URLs
  const unique = new Map();

  for (const article of allArticles) {
    if (!unique.has(article.url)) {
      unique.set(article.url, article);
    }
  }

  allArticles = [...unique.values()];

  // Only process new articles
  const newArticles = allArticles.filter(
    article => !oldUrls.has(article.url)
  );

  console.log(`Found ${newArticles.length} new articles.`);

  // Newest first
  newArticles.sort(
    (a, b) =>
      new Date(b.publishedAt).getTime() -
      new Date(a.publishedAt).getTime()
  );

  const processed = [];

  for (const article of newArticles.slice(0, MAX_AI_ARTICLES)) {
    console.log("AI analyzing:", article.title);

    const aiResult = await analyzeWithGemini(article);

    const recencyScore = getRecencyScore(article.publishedAt);

    const importanceScore =
      Math.max(1, Math.min(10, Number(aiResult.importance) || 5)) * 10;

    const trendingScore = Math.round(
      recencyScore * 0.55 +
      importanceScore * 0.45
    );

    processed.push({
      id: Buffer.from(article.url).toString("base64").slice(0, 20),
      title: article.title,
      summary: aiResult.summary || article.description,
      snippet: aiResult.summary || article.description,
      category: aiResult.category || getCategory(article.title),
      source: article.source,
      url: article.url,
      publishedAt: article.publishedAt,
      date: new Date(article.publishedAt).toLocaleString("en-IN"),
      trendingScore
    });
  }

  // Keep old archive permanently
  const archive = [...processed, ...oldNews];

  // Final duplicate protection
  const finalMap = new Map();

  for (const article of archive) {
    if (!article.url) continue;

    const url = normalizeUrl(article.url);

    if (!finalMap.has(url)) {
      finalMap.set(url, article);
    }
  }

  const finalNews = [...finalMap.values()];

  // Latest + trending first
  finalNews.sort((a, b) => {
    const scoreDifference =
      (b.trendingScore || 0) - (a.trendingScore || 0);

    if (scoreDifference !== 0) {
      return scoreDifference;
    }

    return (
      new Date(b.publishedAt || 0).getTime() -
      new Date(a.publishedAt || 0).getTime()
    );
  });

  fs.writeFileSync(
    NEWS_FILE,
    JSON.stringify(finalNews, null, 2),
    "utf8"
  );

  console.log(`✅ Archive saved: ${finalNews.length} articles`);
}

main().catch(error => {
  console.error("❌ Update failed:", error);
  process.exit(1);
});
```
