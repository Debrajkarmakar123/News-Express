
import fs from "fs";
import Parser from "rss-parser";
import { GoogleGenAI } from "@google/genai";

const parser = new Parser({
  timeout: 20000
});

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  throw new Error("GEMINI_API_KEY is missing");
}

const ai = new GoogleGenAI({
  apiKey: GEMINI_API_KEY
});

const NEWS_FILE = "./news.json";

const MAX_CANDIDATES = 20;
const MAX_NEWS_AGE_HOURS = 48;

const MIN_ARTICLE_WORDS = 700;
const TARGET_ARTICLE_WORDS = 1100;
const MAX_ARTICLE_WORDS = 1500;

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
  return String(text)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanArticle(text = "") {
  return String(text)
    .replace(/\r/g, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function wordCount(text = "") {
  return cleanArticle(text)
    .split(/\s+/)
    .filter(Boolean)
    .length;
}

function normalizeUrl(url = "") {
  try {
    const u = new URL(url);

    u.hash = "";

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
    (Date.now() - time) / 3600000
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

  return 10;
}

/*
  Safely extract URL meta tags.
*/
function extractMetaUrl(html, property, baseUrl) {
  const escapedProperty =
    property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const regex1 = new RegExp(
    "<meta[^>]+(?:property|name)=[\"']" +
      escapedProperty +
      "[\"'][^>]+content=[\"']([^\"']+)[\"'][^>]*>",
    "i"
  );

  const regex2 = new RegExp(
    "<meta[^>]+content=[\"']([^\"']+)[\"'][^>]+(?:property|name)=[\"']" +
      escapedProperty +
      "[\"'][^>]*>",
    "i"
  );

  const match =
    html.match(regex1) ||
    html.match(regex2);

  if (!match) {
    return "";
  }

  try {
    return new URL(
      match[1].trim(),
      baseUrl
    ).href;
  } catch {
    return "";
  }
}

/*
  Safely extract normal text meta tags.
*/
function extractMetaText(html, property) {
  const escapedProperty =
    property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const regex1 = new RegExp(
    "<meta[^>]+(?:property|name)=[\"']" +
      escapedProperty +
      "[\"'][^>]+content=[\"']([^\"']+)[\"'][^>]*>",
    "i"
  );

  const regex2 = new RegExp(
    "<meta[^>]+content=[\"']([^\"']+)[\"'][^>]+(?:property|name)=[\"']" +
      escapedProperty +
      "[\"'][^>]*>",
    "i"
  );

  const match =
    html.match(regex1) ||
    html.match(regex2);

  if (!match) {
    return "";
  }

  return cleanText(match[1]);
}

function extractPageText(html) {
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");

  const blocks = [
    ...body.matchAll(
      /<(?:article|main|p|h1|h2|h3|li)[^>]*>([\s\S]*?)<\/(?:article|main|p|h1|h2|h3|li)>/gi
    )
  ]
    .map(match => cleanText(match[1]))
    .filter(text => text.length >= 40);

  const unique = [
    ...new Set(blocks)
  ];

  return unique
    .join("\n\n")
    .slice(0, 35000);
}

async function fetchSourcePage(url) {
  try {
    console.log("Fetching source page...");

    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; News-Express/1.0)"
      },
      redirect: "follow",
      signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}`
      );
    }

    const finalUrl =
      response.url || url;

    const html =
      await response.text();

    const image =
      extractMetaUrl(
        html,
        "og:image",
        finalUrl
      ) ||
      extractMetaUrl(
        html,
        "twitter:image",
        finalUrl
      );

    const video =
      extractMetaUrl(
        html,
        "og:video",
        finalUrl
      ) ||
      extractMetaUrl(
        html,
        "og:video:url",
        finalUrl
      ) ||
      extractMetaUrl(
        html,
        "twitter:player:stream",
        finalUrl
      );

    const description =
      extractMetaText(
        html,
        "og:description"
      ) ||
      extractMetaText(
        html,
        "description"
      );

    const text =
      extractPageText(html);

    return {
      finalUrl,
      image,
      video,
      description,
      text
    };

  } catch (error) {
    console.log(
      `Source page unavailable: ${error.message}`
    );

    return {
      finalUrl: url,
      image: "",
      video: "",
      description: "",
      text: ""
    };
  }
}

function getFeedMedia(item) {
  const imageCandidates = [
    item.enclosure?.type?.startsWith?.("image/")
      ? item.enclosure.url
      : "",

    item["media:content"]?.url,
    item["media:thumbnail"]?.url,
    item.media?.content?.url,
    item.media?.thumbnail?.url
  ];

  const image =
    imageCandidates.find(
      url =>
        url &&
        /^https?:\/\//i.test(url)
    ) || "";

  const html = [
    item.content,
    item["content:encoded"],
    item.summary,
    item.description
  ]
    .filter(Boolean)
    .join(" ");

  const youtube =
    html.match(
      /https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)[^\s"'<>]+/i
    );

  const directVideo =
    item.enclosure?.type?.startsWith?.("video/")
      ? item.enclosure.url
      : "";

  const video =
    youtube?.[0]
      ?.replace(/[),.;]+$/, "") ||
    directVideo ||
    "";

  return {
    image,
    video
  };
}

async function fetchFeeds() {
  const articles = [];

  for (const feed of FEEDS) {
    try {
      console.log(
        `Fetching: ${feed.name}`
      );

      const result =
        await parser.parseURL(feed.url);

      for (const item of result.items || []) {
        if (!item.link || !item.title) {
          continue;
        }

        const media =
          getFeedMedia(item);

        articles.push({
          title: cleanText(item.title),

          url: normalizeUrl(
            item.link
          ),

          source: feed.name,

          publishedAt:
            item.isoDate ||
            item.pubDate ||
            new Date().toISOString(),

          description:
            cleanText(
              item.contentSnippet ||
              item.content ||
              item.summary ||
              ""
            ),

          image: media.image,

          video: media.video
        });
      }

    } catch (error) {
      console.log(
        `Feed failed: ${feed.name} - ${error.message}`
      );
    }
  }

  return articles;
}

function storyKey(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .split(" ")
    .filter(Boolean)
    .slice(0, 10)
    .join(" ");
}

function groupSimilarStories(articles) {
  const groups = new Map();

  for (const article of articles) {
    const key =
      storyKey(article.title);

    if (!groups.has(key)) {
      groups.set(key, []);
    }

    groups
      .get(key)
      .push(article);
  }

  return groups;
}

async function generateArticle(
  story,
  sourcePage
) {
  const sourceMaterial = [
    `HEADLINE: ${story.title}`,

    `RSS DESCRIPTION:
${story.description || "Not available"}`,

    `SOURCE PAGE DESCRIPTION:
${sourcePage.description || "Not available"}`,

    `SOURCE PAGE FACTUAL TEXT:
${sourcePage.text || "Not available"}`
  ].join("\n\n");

  const prompt = `
You are the senior news writer for NEWS-EXPRESS.

Create a complete original long-form news article from the verified material below.

The article must be ORIGINAL WRITING.
Do not copy sentences or paragraphs from the source.

Generate these six fields:

1. headline
2. summary
3. article
4. category
5. tags
6. keyPoints

HEADLINE:
- Fresh and factual.
- No clickbait.
- No exaggeration.

SUMMARY:
- 3 to 4 complete sentences.
- Clearly explain the main development.

ARTICLE:
- Target approximately ${TARGET_ARTICLE_WORDS} words.
- Minimum ${MIN_ARTICLE_WORDS} words.
- Maximum ${MAX_ARTICLE_WORDS} words.
- Use multiple sections.
- Every section heading must begin with exactly:
## 
- Use normal paragraphs.
- Explain what happened.
- Explain important details.
- Include background/context only when supported by the supplied material.
- Explain implications only when supported by the supplied material.

FACTUAL RULES:
- Do not invent facts.
- Do not invent people.
- Do not invent dates.
- Do not invent numbers.
- Do not invent locations.
- Do not invent quotes.
- Do not invent statistics.
- Do not invent causes.
- Do not make unsupported predictions.
- If information is unavailable, leave it out.
- Never present guesses as facts.

ORIGINALITY:
- Rewrite everything in your own words.
- Do not copy source sentences.
- Do not reproduce source paragraphs.
- Synthesize the information.

TAGS:
- Generate 4 to 8 relevant short tags.

KEY POINTS:
- Generate 4 to 6 concise factual points.

CATEGORY:
Choose exactly one:
India
World
Technology
Business
Sports
Entertainment
Science
Other

Return ONLY valid JSON.

VERIFIED SOURCE MATERIAL:

${sourceMaterial}
`;

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
        type: "string",
        enum: [
          "India",
          "World",
          "Technology",
          "Business",
          "Sports",
          "Entertainment",
          "Science",
          "Other"
        ]
      },

      tags: {
        type: "array",
        items: {
          type: "string"
        },
        minItems: 4,
        maxItems: 8
      },

      keyPoints: {
        type: "array",
        items: {
          type: "string"
        },
        minItems: 4,
        maxItems: 6
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

  const response =
    await ai.models.generateContent({
      model: "gemini-3.5-flash-lite",

      contents: prompt,

      config: {
        responseMimeType: "application/json",
        responseSchema: schema,
        temperature: 0.7,
        maxOutputTokens: 9000
      }
    });

  if (!response.text) {
    throw new Error(
      "Gemini returned empty response"
    );
  }

  let result;

  try {
    result = JSON.parse(
      response.text.trim()
    );
  } catch {
    throw new Error(
      "Gemini returned invalid JSON"
    );
  }

  result.article =
    cleanArticle(
      result.article
    );

  const words =
    wordCount(result.article);

  console.log(
    `Gemini article length: ${words} words`
  );

  if (words < MIN_ARTICLE_WORDS) {
    throw new Error(
      `Article too short: ${words} words`
    );
  }

  if (words > MAX_ARTICLE_WORDS) {
    const paragraphs =
      result.article.split(/\n\s*\n/);

    let output = "";
    let count = 0;

    for (const paragraph of paragraphs) {
      const paragraphWords =
        wordCount(paragraph);

      if (
        count + paragraphWords >
        MAX_ARTICLE_WORDS
      ) {
        break;
      }

      output +=
        (output ? "\n\n" : "") +
        paragraph;

      count += paragraphWords;
    }

    if (
      wordCount(output) >=
      MIN_ARTICLE_WORDS
    ) {
      result.article = output;
    }
  }

  return result;
}

function createFallbackArticle(
  story
) {
  const description =
    story.description ||
    "Latest news update available from the news feed.";

  return {
    id:
      `${Date.now()}-` +
      Math.random()
        .toString(36)
        .slice(2, 8),

    headline:
      story.title,

    originalTitle:
      story.title,

    summary:
      description,

    article:
`## ${story.title}

${description}

## Latest Update

This article is based on the latest information available in the news feed. More verified information will be added when it becomes available.`,

    category:
      "Other",

    tags: [],

    keyPoints: [
      description
    ],

    image:
      story.image || null,

    video:
      story.video || null,

    publishedAt:
      story.publishedAt,

    addedAt:
      new Date().toISOString(),

    editorialScore:
      recencyScore(
        story.publishedAt
      ),

    url:
      normalizeUrl(story.url)
  };
}

async function main() {
  console.log(
    "Starting News-Express updater..."
  );

  const oldNews =
    loadNews();

  const oldUrls =
    new Set(
      oldNews
        .map(item =>
          normalizeUrl(item.url)
        )
        .filter(Boolean)
    );

  console.log(
    `Existing archive: ${oldNews.length} articles`
  );

  const fetched =
    await fetchFeeds();

  console.log(
    `Fetched: ${fetched.length} RSS items`
  );

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

  const candidates =
    [...unique.values()]
      .filter(
        item =>
          hoursOld(
            item.publishedAt
          ) <= MAX_NEWS_AGE_HOURS
      )
      .filter(
        item =>
          !oldUrls.has(
            item.url
          )
      )
      .sort(
        (a, b) =>
          new Date(
            b.publishedAt
          ) -
          new Date(
            a.publishedAt
          )
      )
      .slice(
        0,
        MAX_CANDIDATES
      );

  console.log(
    `Candidates for AI generation: ${candidates.length}`
  );

  const groups =
    groupSimilarStories(
      candidates
    );

  const newArticles = [];

  for (const [, group] of groups) {
    const primary =
      group[0];

    if (
      oldUrls.has(
        primary.url
      )
    ) {
      continue;
    }

    console.log(
      `\nProcessing: ${primary.title}`
    );

    const sourcePage =
      await fetchSourcePage(
        primary.url
      );

    const finalUrl =
      normalizeUrl(
        sourcePage.finalUrl ||
        primary.url
      );

    if (
      oldUrls.has(finalUrl)
    ) {
      continue;
    }

    const image =
      sourcePage.image ||
      primary.image ||
      null;

    const video =
      sourcePage.video ||
      primary.video ||
      null;

    try {
      console.log(
        "Generating article with Gemini..."
      );

      const generated =
        await generateArticle(
          primary,
          sourcePage
        );

      const score =
        recencyScore(
          primary.publishedAt
        ) +
        Math.min(
          group.length * 10,
          40
        );

      newArticles.push({
        id:
          `${Date.now()}-` +
          Math.random()
            .toString(36)
            .slice(2, 8),

        headline:
          generated.headline,

        originalTitle:
          primary.title,

        summary:
          generated.summary,

        article:
          generated.article,

        category:
          generated.category,

        tags:
          generated.tags,

        keyPoints:
          generated.keyPoints,

        image,

        video,

        publishedAt:
          primary.publishedAt,

        addedAt:
          new Date().toISOString(),

        editorialScore:
          score,

        url:
          finalUrl
      });

      console.log(
        `Generated successfully: ${wordCount(generated.article)} words`
      );

    } catch (error) {
      console.log(
        `Gemini generation failed: ${error.message}`
      );

      /*
        Gemini fail hone par bhi
        news.json me item save hoga.
      */

      const fallback =
        createFallbackArticle({
          ...primary,
          url: finalUrl,
          image,
          video
        });

      newArticles.push(
        fallback
      );

      console.log(
        "Fallback article saved."
      );
    }
  }

  const archive = [
    ...newArticles,
    ...oldNews
  ];

  archive.sort(
    (a, b) =>
      new Date(
        b.publishedAt
      ) -
      new Date(
        a.publishedAt
      )
  );

  saveNews(
    archive
  );

  console.log(
    `\nAdded ${newArticles.length} new articles`
  );

  console.log(
    `Permanent archive now contains ${archive.length} articles`
  );

  console.log(
    "news.json saved successfully."
  );

  console.log(
    "Done."
  );
}

main().catch(error => {
  console.error(
    "Updater failed:",
    error
  );

  process.exit(1);
});

