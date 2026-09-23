# Jev HTTP API reference

This page restates the TypeSafe HTTP API as documented at docs.typesafe.ai, as of the
2026-09 docs snapshot (model `jev-1.13.0`, JavaScript SDK 0.6.0). Where the docs are
silent, this page says so instead of filling the gap.

## Endpoint and authentication

```http
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <API_KEY>
Content-Type: application/json
```

- One endpoint serves every model. The request's `model` field picks the model.
- API keys come from the dashboard at https://console.typesafe.ai/keys.
- The SDKs and the docs' curl examples read the key from the environment variable
  `TYPESAFE_API_KEY`.
- The docs do not say whether a key is scoped to a user, an organisation or a project,
  and they do not describe key rotation or per-key quotas.

A minimal curl call, as the Quick start gives it:

```bash
curl -X POST https://api.typesafe.ai/v1/systemone \
  -H "Authorization: Bearer $TYPESAFE_API_KEY" \
  -H "Content-Type: application/json" \
  -d @- <<'EOF'
  {
    "state": "Hi, I've been trying to connect my Stripe account for 3 days and the integration keeps failing. I'm losing sales. Please help ASAP.",
    "model": "jev-latest",
    "questions": {
      "urgency": {
        "type": "noul",
        "instructions": "Does this message express urgency?"
      }
    }
  }
EOF
```

Source: https://docs.typesafe.ai/api, https://docs.typesafe.ai/introduction/quickstart

## Request body

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `state` | string, object or array | yes | The content to evaluate. |
| `model` | string | yes | The model that handles the request, for example `"jev-latest"`. |
| `questions` | map of question id to Question | yes | The questions. You choose each key, and the answer comes back under the same key. |

The question id (the map key) is not sent to the model and is not used in inference.
The docs therefore say to write the whole question in `instructions`, even when the id
looks self-explanatory.

Every question in a request sees the same state and is evaluated independently and in
parallel. One answer is never context for another question.

```json
{
  "state": "Help! My payouts have been failing for 3 days.",
  "model": "jev-latest",
  "questions": {
    "is_urgent": {
      "type": "noul",
      "instructions": "Does this convey urgency?"
    }
  }
}
```

The HTTP reference marks `model` as required. The SDKs fill it in from their default
(`jev-latest`) when a caller leaves it out; see [javascript-sdk.md](javascript-sdk.md).

The docs give no maximum number of questions per request. The only bound they state is
the token budget (see [Context limits](#context-limits)).

Source: https://docs.typesafe.ai/api, https://docs.typesafe.ai/primitives

### State

`state` can be:

| Format | Useful for | Example |
| --- | --- | --- |
| String | A message, article or passage | `"My card was charged twice."` |
| Object | Named fields, related records or application state | `{"message": "My card was charged twice.", "order_id": "A-104"}` |
| Array | A sequence of messages or records | `["Hi", "My customer number is TS1337.", "My card was charged twice."]` |

The docs recommend an object for most requests, so that each part of the state has a
descriptive name. Questions can point at part of an object state with a backticked
dot-and-index path such as `` `ticket.messages[0].text` ``.

State must be text: a string, a JSON object, or an array of text values. Images, audio
and video are not supported.

Source: https://docs.typesafe.ai/concepts/state

## Question types

Every question has `type` and `instructions`. Choice and Score also require `criteria`;
for a Noul, `criteria` is optional.

`instructions` can be a string, an object or an array. An object can hold the question in
one field and the data it refers to in the other fields, with the question naming those
fields in backticks:

```json
"instructions": {
  "potential_duplicate": {
    "name": "John Smith",
    "location": "Oakland, California",
    "last_employer": "Google"
  },
  "question": "Is the resume for the same person as `potential_duplicate`?"
}
```

The field names inside such objects (`question`, `focus`, `what`, `not_for`, `examples`
and so on) are not part of the API, and none is reserved. The model sees the names along
with the values.

The "Advanced: structure" page lists `null` as an accepted shape for `instructions` and
for criteria descriptions. The HTTP reference lists `instructions` as required with type
`string | object | array`. The two pages disagree on whether `instructions` may be null
or omitted. The JavaScript SDK types make it optional.

Source: https://docs.typesafe.ai/api#question-types, https://docs.typesafe.ai/primitives/advanced

### Noul (yes/no)

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `type` | `"noul"` | yes | |
| `instructions` | string, object or array | yes | The yes/no question, or a statement to judge. |
| `criteria` | object | no | Optional descriptions of what yes and no mean. |
| `criteria.true` | string, object or array | no | What a yes (a value near 1) means. |
| `criteria.false` | string, object or array | no | What a no (a value near 0) means. |

```json
{
  "state": "Help! My payouts have been failing for 3 days.",
  "model": "jev-latest",
  "questions": {
    "is_urgent": {
      "type": "noul",
      "instructions": "Does this convey urgency?",
      "criteria": {
        "true": "Explicitly time-sensitive",
        "false": "No urgency expressed"
      }
    }
  }
}
```

Source: https://docs.typesafe.ai/api#noul

### Choice (one of a set)

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `type` | `"choice"` | yes | |
| `instructions` | string, object or array | yes | What the model should decide. |
| `criteria` | map of option to string, object, array or null | yes | Each key is an option name; each value describes it. Use `null` when the name needs no description. |

Limit: at most **255 options** per Choice. Both option names and descriptions are sent to
the model.

One cookbook (Classification using confidence, run on `jev-1.12`) states that "a Choice
works reliably up to roughly 240 options". That is a usability remark, not the API limit,
and the docs do not explain the gap between the two numbers.

```json
{
  "state": "Help! My payouts have been failing for 3 days.",
  "model": "jev-latest",
  "questions": {
    "department": {
      "type": "choice",
      "instructions": "Which team should handle this?",
      "criteria": {
        "billing": "Payments, invoicing, refunds",
        "technical": "Bugs, outages, integrations",
        "sales": "Pricing, upgrades, new accounts"
      }
    }
  }
}
```

Source: https://docs.typesafe.ai/api#choice, https://docs.typesafe.ai/primitives/choice,
https://docs.typesafe.ai/cookbooks/classification_using_confidence

### Score (ordered levels)

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `type` | `"score"` | yes | |
| `instructions` | string, object or array | yes | What the model should rate. |
| `criteria` | array of string, object or array | yes | Ordered level descriptions, low end first. Level numbers are array positions, starting at 0. |

Limits: at least **2** levels; the API accepts up to **10**.

JavaScript SDK 0.6.0 (2026-09-15) changed `Score.criteria` from a dictionary keyed by
integers to an ordered sequence, and marked this as a breaking change. The HTTP reference
documents only the array form.

```json
{
  "state": "Help! My payouts have been failing for 3 days.",
  "model": "jev-latest",
  "questions": {
    "frustration": {
      "type": "score",
      "instructions": "How frustrated is the customer?",
      "criteria": ["Calm", "Frustrated", "Very angry"]
    }
  }
}
```

Source: https://docs.typesafe.ai/api#score, https://docs.typesafe.ai/primitives/score,
https://docs.typesafe.ai/sdk/javascript/changelog

## Response body

| Field | Type | Meaning |
| --- | --- | --- |
| `model` | string | The versioned model that answered, for example `"jev-1.13.0"`. |
| `answers` | map of question id to Answer | One answer per question, under the ids you sent. |
| `usage.input_tokens` | integer | Input tokens for the request. |
| `usage.output_tokens` | integer | Output tokens for the request. |

Every answer carries a `type` that matches its question. Choice and Score answers also
carry a `confidence` between 0 and 1, derived from the probability distribution. Noul
answers carry no `confidence`.

The docs describe no streaming mode, no partial responses, and no per-question errors
inside a successful response.

Source: https://docs.typesafe.ai/api#response-body

### Noul answer

| Field | Type | Meaning |
| --- | --- | --- |
| `type` | `"noul"` | |
| `noul` | number | The answer on a scale from 0 (no) to 1 (yes): the probability of yes. |

```json
{
  "model": "jev-1.13.0",
  "answers": {
    "is_urgent": {
      "type": "noul",
      "noul": 0.95
    }
  },
  "usage": { "input_tokens": 307, "output_tokens": 20 }
}
```

### Choice answer

| Field | Type | Meaning |
| --- | --- | --- |
| `type` | `"choice"` | |
| `choice` | string | The option with the highest probability. |
| `probabilities` | map of option to number | Every option and its probability. The values sum to 1. |
| `confidence` | number | How certain the model is, derived from `probabilities`. |

```json
{
  "model": "jev-1.13.0",
  "answers": {
    "department": {
      "type": "choice",
      "choice": "billing",
      "probabilities": { "billing": 0.88, "technical": 0.12, "sales": 0.0 },
      "confidence": 0.81
    }
  },
  "usage": { "input_tokens": 318, "output_tokens": 34 }
}
```

The docs do not say which option wins when two are tied.

### Score answer

| Field | Type | Meaning |
| --- | --- | --- |
| `type` | `"score"` | |
| `score` | number | The probability-weighted mean of the level numbers. It can fall between levels. |
| `legend` | map of level (string key) to description | Each level number mapped back to its description. When the criteria are objects, the legend echoes the objects. |
| `probabilities` | map of level (string key) to number | Each level's probability. The values sum to 1. |
| `confidence` | number | How certain the model is, derived from `probabilities`. |

```json
{
  "model": "jev-1.13.0",
  "answers": {
    "frustration": {
      "type": "score",
      "score": 1.05,
      "legend": { "0": "Calm", "1": "Frustrated", "2": "Very angry" },
      "probabilities": { "0": 0.0, "1": 0.95, "2": 0.05 },
      "confidence": 0.92
    }
  },
  "usage": { "input_tokens": 304, "output_tokens": 18 }
}
```

The range of `score` is 0 to `len(criteria) - 1`. The docs normalise it to 0–1 by
dividing by that top level number.

Source: https://docs.typesafe.ai/api#answer-types, https://docs.typesafe.ai/primitives/score

### A mixed request and its response

This example from the Quick start asks all three types at once:

```json
{
  "state": "Hi, I've been trying to connect my Stripe account for 3 days and the integration keeps failing. I'm losing sales. Please help ASAP.",
  "model": "jev-latest",
  "questions": {
    "department": {
      "type": "choice",
      "instructions": "Which team should handle this",
      "criteria": {
        "billing": "Payment or subscription issues",
        "technical": "Bugs or integration problems",
        "sales": "Pricing or account questions"
      }
    },
    "frustration": {
      "type": "score",
      "instructions": "How frustrated the customer appears",
      "criteria": [
        "Calm, just stating facts",
        "Frustrated but civil",
        "Very angry, strong language"
      ]
    },
    "is_urgent": {
      "type": "noul",
      "instructions": "The message conveys urgency or time-sensitivity"
    }
  }
}
```

```json
{
  "model": "jev-1.13.0",
  "answers": {
    "department": {
      "type": "choice",
      "choice": "technical",
      "confidence": 0.78,
      "probabilities": {
        "technical": 0.85,
        "sales": 0.0,
        "billing": 0.15
      }
    },
    "frustration": {
      "type": "score",
      "score": 1.0,
      "confidence": 1.0,
      "legend": {
        "0": "Calm, just stating facts",
        "1": "Frustrated but civil",
        "2": "Very angry, strong language"
      },
      "probabilities": {
        "0": 0.0,
        "1": 1.0,
        "2": 0.0
      }
    },
    "is_urgent": {
      "type": "noul",
      "noul": 1.0
    }
  },
  "usage": {
    "input_tokens": 392,
    "output_tokens": 65
  }
}
```

Source: https://docs.typesafe.ai/introduction/quickstart

## Errors

Errors use standard HTTP status codes with a JSON body that describes the problem. The
docs do not publish the body's schema.

| Status | Meaning (from the docs) |
| --- | --- |
| `401 Unauthorized` | Missing or invalid API key. Check the `Authorization` header. |
| `422 Unprocessable Entity` | The body failed validation, for example a missing required field or a malformed question. The body names the offending field. |
| `429 Too Many Requests` | You exceeded your rate limit. Back off and retry after a short delay. |
| `529 Overloaded` | TypeSafe is temporarily overloaded. Retry after a short delay. |

The JavaScript SDK also defines error classes for 400, 403, 404 and other 5xx statuses
(see [javascript-sdk.md](javascript-sdk.md#error-classes)). The HTTP reference does not
say when the server returns those codes.

Responses can carry a request id in the `x-typesafe-request-id` header. The JavaScript
SDK exposes it on errors and through `withResponse()`. The HTTP reference does not
mention the header.

Source: https://docs.typesafe.ai/api#errors, https://docs.typesafe.ai/sdk/javascript/api/classes/APIError

### Retry guidance

- On `429` or `529`, retry with exponential backoff instead of retrying at once.
- The SDKs do this by default and honour the `retry-after` header when the response has
  one. The JavaScript SDK also reads `retry-after-ms`.
- The docs do not say whether `529` responses carry `retry-after`, and they do not say
  whether a request is billed when it fails.

The JavaScript SDK's default policy is a useful model for a direct HTTP client: up to 2
retries after the first attempt; retry on 408, 429 and 500–599, and on connection errors
and timeouts; backoff starting at 500 ms, doubling to at most 5000 ms, with up to 25%
jitter subtracted; honour `Retry-After` up to 60000 ms. Details are in
[javascript-sdk.md](javascript-sdk.md#retry-and-backoff).

Source: https://docs.typesafe.ai/api#handling-rate-limits, https://docs.typesafe.ai/models,
https://docs.typesafe.ai/sdk/javascript/api/interfaces/RetryPolicy

## Listing models: `GET /v1/models`

```bash
curl https://api.typesafe.ai/v1/models \
  -H "Authorization: Bearer $TYPESAFE_API_KEY"
```

This returns the names your account can send in the `model` field. The Models page
describes the body as follows:

| Field | Type | Meaning |
| --- | --- | --- |
| `models` | array | One entry per model or alias. |
| `models[].name` | string | The model id or alias, as the `model` field accepts it. |
| `models[].description` | string | What the model is for. |
| `models[].release_date` | string | When the model or alias was released. |

The list currently shows only the aliases. Versioned ids such as `jev-1.13.0` are
accepted in `model` whether or not they appear in the list.

The JavaScript SDK's `client.models.list()` resolves to `ModelCard[]` (a plain array),
while the HTTP body above is an object with a `models` array. The docs do not show a raw
HTTP response body for this endpoint.

Source: https://docs.typesafe.ai/models#listing-models

## Models and aliases

| Name | Kind | Points to | Meaning |
| --- | --- | --- | --- |
| `jev-1.13.0` | versioned id | — | The current model. |
| `jev-latest` | alias | `jev-1.13.0` | The most recent stable, official release. The SDK default, and the name the docs use. |
| `jev-preview` | alias | `jev-1.13.0` | The most recent release, official or not. It moves ahead of `jev-latest` when a preview build exists. There is none today. |

An alias moves when a new release ships, so the answers behind it can change without any
change on your side. The response's `model` field reports the versioned id that
answered. The docs advise: if you tuned confidence thresholds against a specific version,
pin that version's id and move on your own schedule.

The cookbooks also use the names `jev-1.12` and `jev-1.13` (without a patch number). The
Models page does not list those short forms. It does not say whether a `major.minor`
name resolves, or whether older versions stay available.

Source: https://docs.typesafe.ai/models#aliases

## Price, rate limits and context limits (jev-1.13.0)

| Property | Value |
| --- | --- |
| Price | $42 per billion input tokens ($0.042 per million). Output tokens are free. |
| Rate limits | 250,000 tokens per second, and 1,200 requests per minute. Going over either returns `429`. |
| Context length | 64k tokens per request; 32k tokens for `state` plus the longest single question. |
| Input | Text only: a string, JSON object, or array of text values. |

How the context budget works: Jev reads the `state` once and evaluates every question
against it in parallel. The 64k budget covers the state plus all questions together. The
32k budget covers the state plus the single longest question.

The docs warn that rate limits are "adjusting dynamically" and "can change without
notice" while TypeSafe adds capacity. Higher limits are available on custom and
enterprise plans (sales@typesafe.ai). One cookbook caps its thread pool at 6 workers
because "the public endpoint rate-limits above roughly eight". That is an observation
from the cookbook, not a documented limit.

The docs do not say how tokens are counted (which tokenizer), and they give no way to
count tokens before sending.

Source: https://docs.typesafe.ai/models, https://docs.typesafe.ai/cookbooks/entity_alignment

## Language support

English is the primary training language, and accuracy is best there. Other languages,
including CJK scripts, are accepted but handled less well. The docs say to test on your
own content and to watch confidence closely when routing non-English input.

Source: https://docs.typesafe.ai/models#language-support

## Latency

The API reference states no latency figures. Other pages give these:

- "Most queries complete in about 100 ms." (How to build with TypeSafe)
- "Frontier intelligence at real-time speeds (150ms)" (Example use cases)
- Measured in the cookbooks: a mean round trip of 111 ms for one 14-Noul call and 114 ms
  for one 8-Choice call (15 calls each, `jev-latest`, 2026-09-11). One call with 13
  questions over a roughly 54,000-character document took 0.27 s.

There is no SLA, and no figure for how latency grows with state size.

Source: https://docs.typesafe.ai/concepts/how-to-build-with-system-one,
https://docs.typesafe.ai/concepts/use-case-map,
https://docs.typesafe.ai/cookbooks/consistency_noul_cookbook,
https://docs.typesafe.ai/cookbooks/consistency_choice_cookbook,
https://docs.typesafe.ai/cookbooks/parallel_questions
