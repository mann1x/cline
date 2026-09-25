# Posting news to the home view

The **News** panel on the home view shows the items in `news.json` at the root
of `main`. Every install fetches that file shortly after start-up and then every
six hours, so an item you push shows up within a few hours without a release.

## An item

```json
{
	"version": 1,
	"items": [
		{
			"id": "2026-09-25-v9-agentic",
			"date": "2026-09-25",
			"title": "v9-agentic is out",
			"body": "Tool calling on a 27B, **fast**. [Model card](https://huggingface.co/mann1x).",
			"url": "https://huggingface.co/mann1x",
			"expires": "2026-10-25"
		}
	]
}
```

| field | | |
|---|---|---|
| `id` | required | Unique and never reused. The panel keys "is this new?" on it: a new id re-opens a collapsed panel, and an edited item with the same id does not. |
| `date` | required | `YYYY-MM-DD`. Newest first. An item dated in the future waits until that day, so you can post ahead. |
| `title` | required | One line. |
| `body` | optional | Short markdown. Links open in the browser. |
| `url` | optional | Adds a "Read more" link. `https://` only. |
| `expires` | optional | `YYYY-MM-DD`. Hidden from that day on. |

At most five items are shown. An item missing a required field, or with a date
not in `YYYY-MM-DD` form, is skipped and the rest still show. A file that is
not `version: 1` is ignored and the panel keeps what it last had. With no
current items the panel is hidden.

The parser is `apps/vscode/src/services/news/news-feed.ts`, and its tests say
exactly what is accepted.
