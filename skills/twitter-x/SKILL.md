---
name: twitter-x
description: "Post tweets and read timeline via X (Twitter) API v2 using httpFetch. No browser needed."
metadata:
  cereworker:
    emoji: "\U0001D54F"
    requires:
      tools: ["httpFetch"]
---

# X (Twitter) Skill

Post tweets, read timelines, and check engagement using the X API v2 via `httpFetch`.

## Authentication

X API v2 requires a Bearer token. Check these locations:
1. Environment variable: `$X_BEARER_TOKEN` or `$TWITTER_BEARER_TOKEN`
2. For posting (write access), you need OAuth 1.0a credentials:
   - `$X_API_KEY`, `$X_API_SECRET`, `$X_ACCESS_TOKEN`, `$X_ACCESS_SECRET`

If credentials are missing, tell the user:
> To use X, create an app at https://developer.x.com/en/portal/dashboard
> and set these environment variables:
> - `X_BEARER_TOKEN` (read-only)
> - `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET` (read+write)

## Post a Tweet

Use OAuth 1.0a for write operations. Build the authorization header:

```
shell: python3 -c "
import os, time, hmac, hashlib, base64, urllib.parse, uuid
method = 'POST'
url = 'https://api.twitter.com/2/tweets'
oauth_params = {
    'oauth_consumer_key': os.environ['X_API_KEY'],
    'oauth_nonce': uuid.uuid4().hex,
    'oauth_signature_method': 'HMAC-SHA1',
    'oauth_timestamp': str(int(time.time())),
    'oauth_token': os.environ['X_ACCESS_TOKEN'],
    'oauth_version': '1.0'
}
base = method + '&' + urllib.parse.quote(url, safe='') + '&' + urllib.parse.quote('&'.join(f'{k}={urllib.parse.quote(v, safe=\"\")}' for k, v in sorted(oauth_params.items())), safe='')
key = urllib.parse.quote(os.environ['X_API_SECRET'], safe='') + '&' + urllib.parse.quote(os.environ['X_ACCESS_SECRET'], safe='')
sig = base64.b64encode(hmac.new(key.encode(), base.encode(), hashlib.sha1).digest()).decode()
oauth_params['oauth_signature'] = sig
auth = 'OAuth ' + ', '.join(f'{k}=\"{urllib.parse.quote(v, safe=\"\")}\"' for k, v in sorted(oauth_params.items()))
print(auth)
"
```

Then post:
```
httpFetch:
  url: https://api.twitter.com/2/tweets
  method: POST
  headers:
    Content-Type: application/json
    Authorization: <OAuth header from above>
  body: '{"text": "Your tweet text here"}'
```

## Simpler: Use a CLI tool

If `twurl` or `xh` is available, posting is easier:

```bash
# Install twurl (Ruby gem)
gem install twurl
twurl authorize --consumer-key $X_API_KEY --consumer-secret $X_API_SECRET

# Post a tweet
twurl -X POST /2/tweets -d '{"text":"Hello from CereWorker!"}'
```

Or use `curl` directly with the generated OAuth header.

## Read Timeline / Check Engagement

```
httpFetch:
  url: https://api.twitter.com/2/users/me/tweets?max_results=5&tweet.fields=public_metrics,created_at
  headers:
    Authorization: Bearer $X_BEARER_TOKEN
```

Response includes `public_metrics`: `retweet_count`, `reply_count`, `like_count`, `impression_count`.

## Search Recent Tweets

```
httpFetch:
  url: https://api.twitter.com/2/tweets/search/recent?query=from:username&max_results=10&tweet.fields=public_metrics,created_at
  headers:
    Authorization: Bearer $X_BEARER_TOKEN
```

## Tips
- **Prefer API over browser** — browser automation on X is fragile and gets blocked
- Use `webSearch` to find current X API documentation if endpoints change
- Rate limits: 1500 tweets/month on free tier, check https://developer.x.com/en/docs/twitter-api/rate-limits
- For daily posting tasks, log the tweet ID to memory so you can check engagement next run
