<<<<<<< HEAD
const fs = require('fs');

async function runAutomation() {
  const fetch = (await import('node-fetch')).default;
  const rssUrl = 'https://news.google.com/rss?hl=en-IN&gl=IN&ceid=IN:en';
  console.log("Fetching latest trends...");

  try {
    const res = await fetch(rssUrl);
    const xmlText = await res.text();
    const matches = [...xmlText.matchAll(/<item>[\s\S]*?<title>(.*?)<\/title>[\s\S]*?<\/item>/g)];
    let titles = matches.slice(0, 3).map(m => m[1].replace('<![CDATA[', '').replace(']]>', '').replace(/&amp;/g, '&'));

    if (titles.length === 0) titles = ["Breaking News Update"];

    let currentNews = [];
    if (fs.existsSync('news.json')) {
      currentNews = JSON.parse(fs.readFileSync('news.json', 'utf8'));
    }

    let newArticles = titles.map((title, index) => ({
      id: Date.now() + index,
      title: title,
      snippet: `Viral trending update regarding: ${title}.`,
      date: new Date().toISOString().split('T')[0]
    }));

    const updatedList = [...newArticles, ...currentNews];
    fs.writeFileSync('news.json', JSON.stringify(updatedList, null, 2));
    console.log("News updated permanently without deletion!");

  } catch (error) {
    console.error("Error:", error);
  }
}

=======
const fs = require('fs');

async function runAutomation() {
  const fetch = (await import('node-fetch')).default;
  const rssUrl = 'https://news.google.com/rss?hl=en-IN&gl=IN&ceid=IN:en';
  console.log("Fetching latest trends...");

  try {
    const res = await fetch(rssUrl);
    const xmlText = await res.text();
    const matches = [...xmlText.matchAll(/<item>[\s\S]*?<title>(.*?)<\/title>[\s\S]*?<\/item>/g)];
    let titles = matches.slice(0, 3).map(m => m[1].replace('<![CDATA[', '').replace(']]>', '').replace(/&amp;/g, '&'));

    if (titles.length === 0) titles = ["Breaking News Update"];

    let currentNews = [];
    if (fs.existsSync('news.json')) {
      currentNews = JSON.parse(fs.readFileSync('news.json', 'utf8'));
    }

    let newArticles = titles.map((title, index) => ({
      id: Date.now() + index,
      title: title,
      snippet: `Viral trending update regarding: ${title}.`,
      date: new Date().toISOString().split('T')[0]
    }));

    const updatedList = [...newArticles, ...currentNews];
    fs.writeFileSync('news.json', JSON.stringify(updatedList, null, 2));
    console.log("News updated permanently without deletion!");

  } catch (error) {
    console.error("Error:", error);
  }
}

>>>>>>> 9eb62572ecd57f4bbe89737c44d1ca0c374ac70c
runAutomation();