---
name: article-html
description: Turn a public web article into a self-contained reader HTML file with no banners, callouts, or subscribe prompts. Use when the user wants a clean local HTML page of an article, especially Medium, clipboard URLs, “just the content,” or a layout that occupies the screen.
---

# Article HTML

Build one self-contained `.html` file the user can open. Preserve the article. Do not summarize it. Do not add chrome.

## Find the URL

If the message has no URL, read the clipboard first:

```bash
wl-paste
```

Do not ask for the URL until clipboard and the current message have been checked.

## Fetch the article

Direct `curl` of publisher pages often dies on Cloudflare (`Just a moment...`). Try in this order:

1. Jina reader: `https://r.jina.ai/ARTICLE_URL`
2. Direct fetch with a desktop Chrome user-agent, only if the previous step failed
3. Other public reader mirrors only if 1–2 failed

Confirm the fetch is the article, not a challenge page, empty body, or newsletter interstitial. Keep author, date, title, and canonical URL.

## Strip publisher chrome

Remove, do not restyle:

- subscribe / “get this writer’s stories in your inbox” / “join Medium”
- “Press enter or click to view image in full size”
- clap / share / related-article rails
- cookie, login, paywall, and app-install prompts
- tiny avatars used only as byline decoration
- popup-shaped callouts and notification boxes

Keep hiring links, thanks lines, and footnotes as ordinary body text when they are part of the article. Do not promote them into cards or banners.

Medium (and similar) often emit every heading as `##`. Nest real subsections as `h3` under the actual `h2` sections.

## Images

Download content figures at a large size. For Medium CDN assets:

```text
https://miro.medium.com/v2/resize:fit:2400/<id>
```

Skip 32×32 avatars. Inspect each figure with the image-read tool and write a real alt description. Embed images as `data:image/...;base64,...` so the HTML is one file. A 1–3 MB file is fine.

## Layout

Copy CSS from [assets/reader.css](assets/reader.css) into a `<style>` block. Do not link an external stylesheet.

Required properties of the page:

- only the article occupies the window; no sticky header, no toast, no sidebar
- reading column uses most of a laptop screen (`min(46rem, calc(100vw - 2.4rem))`, wider on large displays)
- type scales with viewport; serif body, quiet sans for kicker/byline/footer
- warm paper background, `prefers-color-scheme` dark variant, not harsh white/black
- figures break out to full viewport width
- quiet footer with author/date and the canonical source link

Skeleton:

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ARTICLE TITLE</title>
<style>/* paste reader.css */</style>
</head>
<body>
<article>
<header>
<p class="kicker">PUBLICATION · READ TIME if known</p>
<h1>Title</h1>
<p class="byline">Author · Date</p>
</header>
<!-- body -->
<footer>Author · Publication · Date<br>Original: <a href="CANONICAL">host/path</a></footer>
</article>
</body>
</html>
```

Generate the file with a short Python snippet when embedding several images.

## Output

Write to `output/` in the current workspace if that directory exists, otherwise a clearly named path under the workspace. Tell the user the absolute path. Do not open a browser unless they ask.

This is a personal reading copy of a public article. Keep attribution. Do not use this skill for books, paywalled dumps, or anything the user cannot already open.
