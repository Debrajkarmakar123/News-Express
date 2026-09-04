import { GoogleGenAI } from "@google/genai";
import Parser from "rss-parser";
import fs from "fs";
import path from "path";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  throw new Error("GEMINI_API_KEY is missing");
}

const ai = new GoogleGenAI({
  apiKey: GEMINI_API_KEY,
});

const parser = new Parser({
  timeout: 20000,
});

const ARCHIVE_FILE = path.join(process.cwd(), "news.json");

const MIN_ARTICLE_WORDS = 700;
const TARGET_ARTICLE_WORDS = 1100;
const MAX_ARTICLE_WORDS = 1500;

const FEEDS = [
  {
    name: "Google News",
    url: "https://news.google.com/rss",
  },
  {
    name: "Google News India",
    url: "https://news.google.com/rss/headlines/section/topic/NATION.en_in",
  },
  {
    name: "Google News Technology",
    url: "https://news.google.com/rss/headlines/section/topic/TECHNOLOGY.en_in",
  },
  {
    name: "Google News Sports",
    url: "https://news.google.com/rss/headlines/section/topic/SPORTS.en_in",
  },
  {
    name: "Google News Entertainment",
    url: "https://news.google.com/rss/headlines/section/topic/ENTERTAINMENT.en_in",
  },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableGeminiError(error) {
  const message = String(error?.message || error || "").toLowerCase();

  return (
    message.includes("503") ||
    message.includes("unavailable") ||
    message.includes("high demand") ||
    message.includes("429") ||
    message.includes("resource_exhausted") ||
    message.includes("500") ||
    message.includes("internal")
  );
}

async function callGemini(prompt, schema) {
  const maxAttempts = 6;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash-lite",
        contents: prompt,
        config: {
          temperature: 0.7,
          maxOutputTokens: 16000,
          responseMimeType: "application/json",
          responseSchema: schema,
        },
      });

      return response;
    } catch (error) {
      if (!isRetryableGeminiError(error) || attempt === maxAttempts) {
        throw error;
      }

      const baseDelay = Math.min(8000 * 2 ** (attempt - 1), 90000);
      const jitter = Math.floor(Math.random() * 3000);
      const delay = baseDelay + jitter;

      console.log(
        `Gemini temporary error. Retry ${attempt}/${maxAttempts - 1} in ${Math.round(
          delay / 1000
        )}s...`
      );

      await sleep(delay);
    }
  }
}

function parseGeminiJson(text) {
  if (!text) {
    throw new Error("Gemini returned empty response");
  }

  let cleaned = text.trim();

  if (cleaned.startsWith("```")) {
    cleaned = cleaned
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
  }

  return JSON.parse(cleaned);
}

function countWords(text) {
  return String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function cleanText(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchFeed(feed) {
  console.log(`Fetching: ${feed.name}`);

  try {
    const result = await parser.parseURL(feed.url);

    return result.items.map((item) => ({
      title: item.title || "",
      link: item.link || "",
      pubDate: item.pubDate || item.isoDate || new Date().toISOString(),
      content: stripHtml(
        item.contentSnippet ||
          item.content ||
          item.summary ||
          item.description ||
          ""
      ),
      source: feed.name,
    }));
  } catch (error) {
    console.log(`Feed failed: ${feed.name}`);
    console.log(error.message);
    return [];
  }
}

async function fetchSourcePage(url) {
  if (!url) return {};

  try {
    console.log("Fetching source page...");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; News-Express/1.0; +https://github.com/)",
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return {};
    }

    const html = await response.text();

    const titleMatch = html.match(
      /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i
    );

    const descriptionMatch = html.match(
      /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i
    );

    const imageMatch = html.match(
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i
    );

    const videoMatch = html.match(
      /<meta[^>]+property=["']og:video["'][^>]+content=["']([^"']+)["']/i
    );

    return {
      title: titleMatch?.[1] || "",
      description: descriptionMatch?.[1] || "",
      image: imageMatch?.[1] || "",
      video: videoMatch?.[1] || "",
    };
  } catch {
    return {};
  }
}

function makeFallbackArticle(item, sourceData) {
  const description =
    sourceData.description ||
    item.content ||
    "The latest report has drawn attention to this developing story.";

  return `
<h2>${item.title}</h2>

<p>${description}</p>

<p>This story is developing and further information may become available as officials, organisations and other reliable sources provide additional details.</p>

<p>News-Express will continue to follow the development and present important updates as they emerge.</p>
`.trim();
}

async function generateArticle(item, sourceData) {
  console.log("Generating article with Gemini...");

  const prompt = `
You are the senior news writer for News-Express.

Write a completely ORIGINAL news article based ONLY on the factual information supplied below.

IMPORTANT:
- Do NOT copy sentences from the source.
- Do NOT imitate the source's wording.
- Rewrite everything naturally in your own words.
- Do NOT invent facts, quotes, statistics, people, locations or events.
- If a detail is uncertain, leave it out.
- Keep the tone neutral, professional and easy to read.
- Do not mention that AI was used.
- Do not mention "source material".
- Do not create fake quotes.

ARTICLE REQUIREMENTS:
- Target length: 1000-1300 words.
- Minimum acceptable length: 800 words.
- Maximum length: 1500 words.
- Use HTML.
- Start with a strong introduction.
- Use 6-10 useful <h2> sections.
- Use normal <p> paragraphs.
- Explain the important facts, context and significance.
- Avoid repetitive sentences.
- End with a concise conclusion.
- Do not use markdown.

HEADLINE:
${item.title}

RSS INFORMATION:
${item.content}

SOURCE PAGE TITLE:
${sourceData.title || ""}

SOURCE PAGE DESCRIPTION:
${sourceData.description || ""}

SOURCE IMAGE:
${sourceData.image || ""}

SOURCE VIDEO:
${sourceData.video || ""}
`;

  const schema = {
    type: "object",
    properties: {
      title: {
        type: "string",
      },
      summary: {
        type: "string",
      },
      article: {
        type: "string",
      },
    },
    required: ["title", "summary", "article"],
  };

  const response = await callGemini(prompt, schema);

  const text =
    response?.text ||
    response?.candidates?.[0]?.content?.parts?.[0]?.text ||
    "";

  const data = parseGeminiJson(text);

  const wordCount = countWords(stripHtml(data.article));

  console.log(`Gemini article length: ${wordCount} words`);

  if (wordCount < 700) {
    console.log("Article too short. Asking Gemini to expand...");

    const expansionPrompt = `
Expand the following news article into a complete, detailed article.

Rules:
- Keep every existing fact accurate.
- Do not invent facts.
- Do not repeat paragraphs.
- Rewrite naturally.
- Add useful context only when supported by the information already present.
- Final article must be 900-1300 words.
- Use HTML.
- Use 6-10 <h2> sections.
- Return ONLY JSON.

Current article:

${data.article}
`;

    const expansionResponse = await callGemini(expansionPrompt, {
      type: "object",
      properties: {
        article: {
          type: "string",
        },
      },
      required: ["article"],
    });

    const expansionText =
      expansionResponse?.text ||
      expansionResponse?.candidates?.[0]?.content?.parts?.[0]?.text ||
      "";

    const expanded = parseGeminiJson(expansionText);

    const expandedWords = countWords(stripHtml(expanded.article));

    console.log(`Expanded article length: ${expandedWords} words`);

    if (expandedWords >= 700) {
      data.article = expanded.article;
    }
  }

  const finalWords = countWords(stripHtml(data.article));

  if (finalWords < MIN_ARTICLE_WORDS) {
    throw new Error(`Article too short: ${finalWords} words`);
  }

  if (finalWords > MAX_ARTICLE_WORDS) {
    const words = stripHtml(data.article).split(/\s+/);

    data.article = words.slice(0, MAX_ARTICLE_WORDS).join(" ");
  }

  return {
    title: cleanText(data.title || item.title),
    summary: cleanText(data.summary || item.content),
    article: cleanText(data.article),
  };
}

function normalizeTitle(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isDuplicate(item, archive) {
  const normalized = normalizeTitle(item.title);

  return archive.some((old) => {
    const oldTitle = normalizeTitle(old.title);

    if (!normalized || !oldTitle) return false;

    if (normalized === oldTitle) return true;

    const a = new Set(normalized.split(" "));
    const b = new Set(oldTitle.split(" "));

    const intersection = [...a].filter((word) => b.has(word)).length;
    const similarity = intersection / Math.max(a.size, b.size);

    return similarity >= 0.75;
  });
}

function loadArchive() {
  if (!fs.existsSync(ARCHIVE_FILE)) {
    return [];
  }

  try {
    const data = JSON.parse(fs.readFileSync(ARCHIVE_FILE, "utf8"));

    return Array.isArray(data) ? data : [];
  } catch {
    console.log("Could not read existing news.json. Starting empty.");
    return [];
  }
}

function saveArchive(archive) {
  fs.writeFileSync(
    ARCHIVE_FILE,
    JSON.stringify(archive, null, 2),
    "utf8"
  );

  console.log("news.json saved successfully.");
}

async function main() {
  console.log("Starting News-Express updater...");

  const archive = loadArchive();

  console.log(`Existing archive: ${archive.length} articles`);

  let allItems = [];

  for (const feed of FEEDS) {
    const items = await fetchFeed(feed);
    allItems.push(...items);
  }

  console.log(`Fetched: ${allItems.length} RSS items`);

  const uniqueItems = [];
  const seenTitles = new Set();

  for (const item of allItems) {
    const normalized = normalizeTitle(item.title);

    if (!normalized) continue;

    if (seenTitles.has(normalized)) continue;

    seenTitles.add(normalized);
    uniqueItems.push(item);
  }

  const candidates = uniqueItems
    .filter((item) => !isDuplicate(item, archive))
    .sort(
      (a, b) =>
        new Date(b.pubDate).getTime() -
        new Date(a.pubDate).getTime()
    )
    .slice(0, 20);

  console.log(`Candidates for AI generation: ${candidates.length}`);

  let added = 0;

  for (const item of candidates) {
    console.log(`Processing: ${item.title}`);

    try {
      const sourceData = await fetchSourcePage(item.link);

      let generated;

      try {
        generated = await generateArticle(item, sourceData);
      } catch (error) {
        console.log(`AI generation failed: ${error.message}`);
        console.log("Saving fallback article.");

        generated = {
          title: item.title,
          summary:
            sourceData.description ||
            item.content ||
            "Latest news update.",
          article: makeFallbackArticle(item, sourceData),
        };
      }

      const article = {
        id: `${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 8)}`,
        title: generated.title,
        summary: generated.summary,
        article: generated.article,
        image:
          sourceData.image ||
          null,
        video:
          sourceData.video ||
          null,
        publishedAt: item.pubDate,
        createdAt: new Date().toISOString(),
        sourceUrl: item.link,
        sourceName: item.source,
      };

      archive.push(article);
      added++;

      console.log("Article saved.");

      await sleep(2500);
    } catch (error) {
      console.log(`Failed processing article: ${error.message}`);
    }
  }

  archive.sort(
    (a, b) =>
      new Date(b.publishedAt || b.createdAt).getTime() -
      new Date(a.publishedAt || a.createdAt).getTime()
  );

  saveArchive(archive);

  console.log(`Added ${added} new articles`);
  console.log(`Permanent archive now contains ${archive.length} articles`);
  console.log("Done.");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
