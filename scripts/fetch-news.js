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

const ALLOWED_CATEGORIES = [
  "India",
  "World",
  "Technology",
  "Business",
  "Sports",
  "Entertainment",
  "Science",
  "Other"
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

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = "";

    return u
      .toString()
      .replace(/\/$/, "");
  } catch {
    return url;
  }
}

function cleanText(text = "") {
  return String(text)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}


/*
  Creates URL-friendly slug.

  Example:
  "India Budget 2026: New Announcement!"
  =>
  "india-budget-2026-new-announcement"
*/
function createSlug(text = "") {
  let slug = cleanText(text)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");

  if (!slug) {
    slug = "news";
  }

  return slug.slice(0, 100);
}


/*
  Makes sure every article has a unique slug.
*/
function createUniqueSlug(title, usedSlugs) {
  const base = createSlug(title);

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
  Existing news from older versions may not have slugs.
  Give those articles stable slugs too.
*/
function migrateOldSlugs(news) {
  const usedSlugs = new Set();

  // First preserve existing slugs
  for (const item of news) {
    if (item.slug) {
      usedSlugs.add(item.slug);
    }
  }

  for (const item of news) {
    if (!item.slug) {
      const title =
        item.headline ||
        item.originalTitle ||
        item.title ||
        "news";

      item.slug = createUniqueSlug(
        title,
        usedSlugs
      );
    }
  }

  return news;
}


function hoursOld(date) {
  const time = new Date(date).getTime();

  if (!Number.isFinite(time)) {
    return 9999;
  }

  return Math.max(
    0,
    (Date.now() - time) /
      (1000 * 60 * 60)
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

      const result =
        await parser.parseURL(feed.url);

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

  if (!process.env.GEMINI_API_KEY) {
    throw new Error(
      "GEMINI_API_KEY is missing."
    );
  }

  const prompt = `
You are a professional news editor.

Analyze the following news article.

Title:
${article.title}

Description:
${article.description}

Source:
${article.source}

Return ONLY valid JSON.

Required format:

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
- Do not add information not supported by the provided title or description.
- Keep the headline accurate.
- Keep the summary factual.
- importance must be an integer from 1 to 10.
- tags should be short and relevant.
`;

  try {

    console.log("Sending article to Gemini...");

    const response =
      await ai.models.generateContent({
        model: "gemini-2.5-flash-lite",

        contents: prompt,

        config: {
          responseMimeType: "application/json"
        }
      });

    const text =
      response.text?.trim() || "";

    if (!text) {
      throw new Error(
        "Gemini returned an empty response."
      );
    }

    const cleaned = text
      .replace(/^```json/i, "")
      .replace(/^```/i, "")
      .replace(/```$/i, "")
      .trim();

    const result =
      JSON.parse(cleaned);

    const headline =
      cleanText(result.headline) ||
      article.title;

    const summary =
      cleanText(result.summary) ||
      article.description ||
      article.title;

    const category =
      ALLOWED_CATEGORIES.includes(
        result.category
      )
        ? result.category
        : "Other";

    const tags =
      Array.isArray(result.tags)
        ? result.tags
            .map(tag => cleanText(tag))
            .filter(Boolean)
            .slice(0, 5)
        : [];

    let importance =
      Number(result.importance);

    if (!Number.isInteger(importance)) {
      importance = 5;
    }

    importance =
      Math.max(
        1,
        Math.min(10, importance)
      );

    return {
      headline,
      summary,
      category,
      tags,
      importance
    };

  } catch (error) {

    console.log(
      "Gemini analysis failed:",
      error.message
    );

    /*
      Fallback means RSS news is still saved
      even if Gemini temporarily fails.
    */
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

  const recent =
    recencyScore(
      article.publishedAt
    );

  const sourceScore =
    Math.min(
      sourceCount * 10,
      40
    );

  const importanceScore =
    Math.min(
      importance,
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


  let oldNews = loadNews();

  console.log(
    `Existing archive: ${oldNews.length} articles`
  );


  /*
    Give old articles slugs if they
    came from an older version.
  */
  oldNews =
    migrateOldSlugs(oldNews);


  const fetched =
    await fetchFeeds();

  console.log(
    `Fetched: ${fetched.length} articles`
  );


  /*
    Remove duplicate RSS URLs.
  */
  const unique =
    new Map();

  for (const article of fetched) {

    if (!unique.has(article.url)) {
      unique.set(
        article.url,
        article
      );
    }
  }


  const articles =
    [...unique.values()];


  const groups =
    groupSimilarStories(
      articles
    );


  const newArticles = [];


  /*
    Reserve all existing slugs.
  */
  const usedSlugs =
    new Set(
      oldNews
        .map(item => item.slug)
        .filter(Boolean)
    );


  for (const [, group] of groups) {

    const primary =
      group[0];


    const alreadyExists =
      oldNews.some(
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
      await aiAnalyze(
        primary
      );


    /*
      Small delay to avoid hammering
      the API with requests.
    */
    await new Promise(
      resolve =>
        setTimeout(resolve, 300)
    );


    const sourceCount =
      group.length;


    const trendingScore =
      calculateTrendingScore({
        article: primary,
        sourceCount,
        importance:
          aiResult.importance
      });


    const slug =
      createUniqueSlug(
        aiResult.headline ||
        primary.title,
        usedSlugs
      );


    newArticles.push({

      /*
        Stable internal identifier.
        This is NOT used in the URL.
      */
      id:
        `${Date.now()}-` +
        Math.random()
          .toString(36)
          .slice(2, 8),

      /*
        Permanent URL slug.
      */
      slug,

      headline:
        aiResult.headline,

      originalTitle:
        primary.title,

      summary:
        aiResult.summary,

      category:
        aiResult.category,

      tags:
        aiResult.tags,

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
        aiResult.importance,

      trendingScore,

      trending:
        trendingScore >= 100
    });
  }


  /*
    Permanent archive.
    New + old.
  */
  const archive = [
    ...newArticles,
    ...oldNews
  ];


  /*
    Latest first.
  */
  archive.sort(
    (a, b) =>
      new Date(b.publishedAt) -
      new Date(a.publishedAt)
  );


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

  console.error(
    "News update failed:",
    error
  );

  process.exit(1);
});
````
