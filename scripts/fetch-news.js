import fs from "fs";
import Parser from "rss-parser";
import { GoogleGenAI } from "@google/genai";

const parser = new Parser({ timeout: 20000 });

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

function absoluteUrl(value, baseUrl) {
  if (!value) {
    return "";
  }

  try {
    return new URL(value, baseUrl).href;
  } catch {
    return "";
  }
}

function extractMeta(html, property, baseUrl) {
  const regex1 = new RegExp(
    `<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']+)["'][^>]*>`,
    "i"
  );

  const regex2 = new RegExp(
    `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${property}["'][^>]*>`,
    "i"
  );

  const match =
    html.match(regex1) ||
    html.match(regex2);

  if (!match) {
    return "";
  }

  return (
    absoluteUrl(match[1].trim(), baseUrl) ||
    cleanText(match[1])
  );
}

function extractPageText(html) {
  let body = html
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
      extractMeta(
        html,
        "og:image",
        finalUrl
      ) ||
      extractMeta(
        html,
        "twitter:image",
        finalUrl
      );

    const video =
      extractMeta(
        html,
        "og:video",
        finalUrl
      ) ||
      extractMeta(
        html,
        "og:video:url",
        finalUrl
      ) ||
      extractMeta(
        html,
        "twitter:player:stream",
        finalUrl
      );

    const description =
      extractMeta(
        html,
        "og:description",
        finalUrl
      ) ||
      extractMeta(
        html,
        "description",
        finalUrl
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

function groupSimilarStories(
  articles
) {
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

Your job is to create a COMPLETE, LONG-FORM NEWS ARTICLE.

Generate the entire article from the verified factual material provided below.

IMPORTANT:
The final article must be ORIGINAL WRITING.
Do not copy sentences or paragraphs from the source.

GENERATE ALL SIX FIELDS:

1. headline
2. summary
3. article
4. category
5. tags
6. keyPoints

HEADLINE:
- Create a fresh headline.
- Keep it factual.
- Do not exaggerate.
- Do not use clickbait.

SUMMARY:
- 3 to 4 complete sentences.
- Clearly explain the main development.

ARTICLE:
- This is extremely important.
- Generate a FULL LONG-FORM ARTICLE.
- Target approximately ${TARGET_ARTICLE_WORDS} words.
- Minimum acceptable length: ${MIN_ARTICLE_WORDS} words.
- Maximum target: ${MAX_ARTICLE_WORDS} words.
- NEVER intentionally return a short article.
- Use multiple sections.
- Every section heading must start with exactly:
  ## 
- Explain what happened.
- Explain the important details.
- Add relevant background/context when the supplied material supports it.
- Explain reactions or implications only when supported by the material.
- Keep the writing natural and professional.
- Use paragraphs, not one giant block.

FACTUAL RULES:
- Do not invent facts.
- Do not invent people.
- Do not invent dates.
- Do not invent numbers.
- Do not invent locations.
- Do not invent quotes.
- Do not invent statistics.
- Do not invent causes.
- Do not predict events without evidence.
- If information is unavailable, leave it out.
- Never present guesses as facts.

ORIGINALITY:
- Rewrite everything in your own words.
- Do not copy source sentences.
- Do not reproduce source paragraphs.
- Synthesize the supplied information into an original article.

TAGS:
- Generate 4 to 8 highly relevant short tags.
- No generic irrelevant tags.

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

OUTPUT:
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
      model: "gemini-2.5-flash-lite",

      contents: prompt,

      config: {
        responseMimeType:
          "application/json",

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

  if (
    words >
    MAX_ARTICLE_WORDS
  ) {
    const wordsArray =
      result.article
        .split(/\s+/);

    result.article =
      wordsArray
        .slice(
          0,
          MAX_ARTICLE_WORDS
        )
        .join(" ");
  }

  return result;
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
    if (
      !unique.has(article.url)
    ) {
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
          ) <=
          MAX_NEWS_AGE_HOURS
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

    /*
      Media priority:
      1. Actual source article
      2. RSS feed
    */

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
        "Generating title, summary, tags and FULL LONG ARTICLE with Gemini..."
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

      console.log(
        `Image: ${image ? "YES" : "NO"}`
      );

      console.log(
        `Video: ${video ? "YES" : "NO"}`
      );
    } catch (error) {
      console.log(
        `AI generation failed: ${error.message}`
      );
    }
  }

  /*
    Permanent archive:
    New + Old
  */

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
