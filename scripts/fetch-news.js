
import fs from "fs";
import Parser from "rss-parser";
import { GoogleGenAI } from "@google/genai";

const parser = new Parser({
  timeout: 15000,
  customFields: {
    item: [
      ["media:content", "mediaContent", { keepArray: true }],
      ["media:thumbnail", "mediaThumbnail", { keepArray: true }],
      ["media:group", "mediaGroup"],
      ["enclosure", "enclosure"]
    ]
  }
});

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

const NEWS_FILE = "./news.json";

const MAX_HOME_NEWS = 10;
const MAX_NEWS_AGE_HOURS = 48;
const MAX_CANDIDATES = 35;

const FEEDS = [
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
  },
  {
    name: "Google News",
    url: "https://news.google.com/rss?hl=en-IN&gl=IN&ceid=IN:en"
  }
];

function loadNews() {
  if (!fs.existsSync(NEWS_FILE)) return [];

  try {
    return JSON.parse(fs.readFileSync(NEWS_FILE, "utf8"));
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
  return String(text)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanArticle(text = "") {
  return String(text)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeUrl(url) {
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

  if (!Number.isFinite(time)) return 9999;

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

  return 5;
}

/*
  RSS se image nikalne ki koshish.
*/
function extractImage(item) {
  // media:thumbnail
  if (item.mediaThumbnail) {
    const media = Array.isArray(item.mediaThumbnail)
      ? item.mediaThumbnail[0]
      : item.mediaThumbnail;

    const url =
      media?.$?.url ||
      media?.url ||
      media?.["media:url"];

    if (url) return url;
  }

  // media:content
  if (item.mediaContent) {
    const list = Array.isArray(item.mediaContent)
      ? item.mediaContent
      : [item.mediaContent];

    for (const media of list) {
      const url =
        media?.$?.url ||
        media?.url;

      const type =
        media?.$?.type ||
        media?.type ||
        "";

      if (
        url &&
        (!type || type.startsWith("image/"))
      ) {
        return url;
      }
    }
  }

  // enclosure
  if (item.enclosure?.url) {
    const type = item.enclosure.type || "";

    if (!type || type.startsWith("image/")) {
      return item.enclosure.url;
    }
  }

  return "";
}

/*
  RSS se video nikalne ki koshish.
  Sirf actual video URL use hoga.
*/
function extractVideo(item) {
  if (item.mediaContent) {
    const list = Array.isArray(item.mediaContent)
      ? item.mediaContent
      : [item.mediaContent];

    for (const media of list) {
      const url =
        media?.$?.url ||
        media?.url;

      const type =
        media?.$?.type ||
        media?.type ||
        "";

      if (
        url &&
        (
          type.startsWith("video/") ||
          /youtube\.com|youtu\.be|vimeo\.com/i.test(url)
        )
      ) {
        return url;
      }
    }
  }

  if (item.enclosure?.url) {
    const type = item.enclosure.type || "";

    if (type.startsWith("video/")) {
      return item.enclosure.url;
    }
  }

  return "";
}

async function fetchFeeds() {
  const articles = [];

  for (const feed of FEEDS) {
    try {
      console.log(`Fetching: ${feed.name}`);

      const result = await parser.parseURL(feed.url);

      for (const item of result.items || []) {
        if (!item.link || !item.title) continue;

        const image = extractImage(item);
        const video = extractVideo(item);

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
          ),

          image,
          video
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

async function selectTopNews(candidates) {
  const schema = {
    type: "object",
    properties: {
      selected: {
        type: "array",
        items: {
          type: "object",
          properties: {
            index: { type: "integer" },
            score: { type: "integer" },
            reason: { type: "string" }
          },
          required: ["index", "score", "reason"]
        }
      }
    },
    required: ["selected"]
  };

  const list = candidates
    .map(
      (item, index) =>
        `${index}: ${item.title}\n${item.description}`
    )
    .join("\n\n");

  const prompt = `
You are a professional news editor.

Select the most important and genuinely newsworthy stories from the list.

Rules:
- Select maximum ${MAX_HOME_NEWS} stories.
- Prefer recent and important news.
- Avoid duplicate stories.
- Avoid clickbait.
- Do not select stories that are clearly unsupported.
- Score each selected story from 1 to 100.
- Return only JSON.

Stories:

${list}
`;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-lite",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: schema
      }
    });

    const data = JSON.parse(response.text);

    return (data.selected || [])
      .filter(
        item =>
          Number.isInteger(item.index) &&
          item.index >= 0 &&
          item.index < candidates.length
      )
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_HOME_NEWS);
  } catch (error) {
    console.log("News selection failed:", error.message);

    return candidates
      .map((item, index) => ({
        index,
        score: recencyScore(item.publishedAt),
        reason: "Fallback selection"
      }))
      .slice(0, MAX_HOME_NEWS);
  }
}

async function generateArticle(article) {
  const schema = {
    type: "object",
    properties: {
      headline: { type: "string" },
      summary: { type: "string" },
      article: { type: "string" },
      category: { type: "string" },
      tags: {
        type: "array",
        items: { type: "string" }
      },
      keyPoints: {
        type: "array",
        items: { type: "string" }
      },
      importance: { type: "integer" }
    },
    required: [
      "headline",
      "summary",
      "article",
      "category",
      "tags",
      "keyPoints",
      "importance"
    ]
  };

  const prompt = `
You are the editor of News-Express.

Create a completely original news article using ONLY the facts available below.

SOURCE TITLE:
${article.title}

SOURCE DESCRIPTION:
${article.description}

IMPORTANT RULES:

1. Do NOT copy sentences or paragraphs from the source.
2. Write everything in your own words.
3. Do NOT invent names, numbers, quotes, dates, locations or events.
4. Never create fake quotations.
5. Be neutral and factual.
6. Target 800-1200 words when enough facts are available.
7. If the available facts are limited, write a shorter article instead of inventing information.
8. Use clear sections.
9. Every section heading MUST start with "## ".
10. Do not include HTML.
11. Do not include source information in the article.
12. The headline must accurately describe the story.

Return only JSON.
`;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-lite",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: schema
      }
    });

    const data = JSON.parse(response.text);

    return {
      headline: data.headline || article.title,
      summary: data.summary || article.description,
      article: cleanArticle(data.article || ""),
      category: data.category || "Other",
      tags: Array.isArray(data.tags) ? data.tags : [],
      keyPoints: Array.isArray(data.keyPoints)
        ? data.keyPoints
        : [],
      importance: Number(data.importance) || 5
    };
  } catch (error) {
    console.log(
      "Article generation failed:",
      error.message
    );

    return {
      headline: article.title,
      summary: article.description || article.title,
      article:
        `## ${article.title}\n\n${article.description || "Detailed information is currently unavailable."}`,
      category: "Other",
      tags: [],
      keyPoints: [],
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

  const oldNews = loadNews();

  console.log(
    `Existing archive: ${oldNews.length} articles`
  );

  const fetched = await fetchFeeds();

  console.log(
    `Fetched: ${fetched.length} articles`
  );

  // Remove duplicate URLs
  const unique = new Map();

  for (const article of fetched) {
    if (!unique.has(article.url)) {
      unique.set(article.url, article);
    }
  }

  let articles = [...unique.values()];

  // Only recent news
  articles = articles.filter(
    article =>
      hoursOld(article.publishedAt) <=
      MAX_NEWS_AGE_HOURS
  );

  // Similar stories
  const groups = groupSimilarStories(articles);

  const candidates = [];

  for (const [, group] of groups) {
    const primary = group[0];

    const alreadyExists = oldNews.some(
      item => item.url === primary.url
    );

    if (alreadyExists) continue;

    candidates.push({
      ...primary,
      sourceCount: group.length
    });
  }

  candidates.sort(
    (a, b) =>
      new Date(b.publishedAt) -
      new Date(a.publishedAt)
  );

  const limitedCandidates =
    candidates.slice(0, MAX_CANDIDATES);

  console.log(
    `New candidates: ${limitedCandidates.length}`
  );

  if (!limitedCandidates.length) {
    console.log("No new news found.");
    return;
  }

  const selected =
    await selectTopNews(limitedCandidates);

  const newArticles = [];

  for (const selection of selected) {
    const primary =
      limitedCandidates[selection.index];

    if (!primary) continue;

    console.log(
      `Generating: ${primary.title}`
    );

    const generated =
      await generateArticle(primary);

    const trendingScore =
      calculateTrendingScore({
        article: primary,
        sourceCount: primary.sourceCount,
        importance: generated.importance
      });

    newArticles.push({
      id:
        `${Date.now()}-` +
        Math.random()
          .toString(36)
          .slice(2, 8),

      headline: generated.headline,

      originalTitle: primary.title,

      summary: generated.summary,

      article: generated.article,

      category: generated.category,

      tags: generated.tags,

      keyPoints: generated.keyPoints,

      source: primary.source,

      sourceCount: primary.sourceCount,

      url: primary.url,

      // Relevant media from RSS
      image: primary.image || "",

      video: primary.video || "",

      publishedAt: primary.publishedAt,

      addedAt: new Date().toISOString(),

      importance: generated.importance,

      editorialScore: selection.score,

      trendingScore,

      trending:
        trendingScore >= 100
    });

    // Small delay
    await new Promise(
      resolve => setTimeout(resolve, 1200)
    );
  }

  // Permanent archive
  const archive = [
    ...newArticles,
    ...oldNews
  ];

  // Remove duplicate URLs from archive
  const archiveMap = new Map();

  for (const item of archive) {
    if (item.url && !archiveMap.has(item.url)) {
      archiveMap.set(item.url, item);
    }
  }

  const finalArchive =
    [...archiveMap.values()];

  finalArchive.sort(
    (a, b) =>
      new Date(b.publishedAt) -
      new Date(a.publishedAt)
  );

  saveNews(finalArchive);

  console.log(
    `Added ${newArticles.length} new articles`
  );

  console.log(
    `Permanent archive: ${finalArchive.length}`
  );

  console.log("Done.");
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

