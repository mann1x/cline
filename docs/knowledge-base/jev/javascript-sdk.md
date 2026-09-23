# TypeSafe JavaScript / TypeScript SDK (`@typesafe-ai/sdk`)

Signatures on this page are copied from the SDK reference at
docs.typesafe.ai/sdk/javascript/api, which documents version **0.6.0**
(`VERSION = "0.6.0"`). The docs point to the source for the options and defaults they do
not list: https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/client.ts and
`src/types.ts`.

## Install and first call

The SDK requires Node.js 20 or newer.

```sh
npm install @typesafe-ai/sdk
```

```ts
import { choice, TypeSafeClient } from "@typesafe-ai/sdk";

const client = new TypeSafeClient();
const response = await client.systemOne({
  state: { document: "I was charged twice. Please fix this ASAP." },
  questions: {
    category: choice("What is this ticket about?", {
      billing: null,
      technical: null,
      other: null,
    }),
  },
});

console.log(response.answers.category.choice);
```

The SDK infers answer types from the questions. The package ships ESM, CommonJS and
TypeScript declarations.

Changelog:

- **v0.6.0 (2026-09-15)**, breaking: `Score.criteria` is now an ordered sequence instead
  of a dictionary keyed by integers.
- **v0.5.7 (2026-09-11)**: first public release.

Source: https://docs.typesafe.ai/sdk/javascript, https://docs.typesafe.ai/sdk/javascript/changelog

## Client construction

```ts
new TypeSafeClient(config?): TypeSafeClient;
```

- `config` is a `TypeSafeClientConfig` and defaults to `{}`.
- Precedence: explicit options, then environment variables, then SDK defaults. Empty or
  whitespace-only environment values are ignored.
- The constructor throws when "The API key is missing, configuration is invalid, or the
  runtime is unsupported."

Source: https://docs.typesafe.ai/sdk/javascript/api/classes/TypeSafeClient

### `TypeSafeClientConfig`

| Option | Type | Fallback / default | Notes |
| --- | --- | --- | --- |
| `apiKey?` | `string` | `TYPESAFE_API_KEY` | Required, either here or in the environment. |
| `baseURL?` | `string` | `TYPESAFE_BASE_URL`, then `https://api.typesafe.ai` | |
| `dangerouslyAllowBrowser?` | `boolean` | `false` | Allows browser use, which exposes the API key to page users. |
| `defaultHeaders?` | `Record<string, string>` | — | Extra request headers; per-call headers win. |
| `defaultModel?` | `string` | `TYPESAFE_DEFAULT_MODEL`, then `jev-latest` | |
| `fetch?` | `Fetch` | global `fetch` | A custom fetch, for transport configuration or tests. |
| `logger?` | `Logger` | prefixed `console` | Filtered to `logLevel` and above. |
| `logLevel?` | `LogLevel` | `TYPESAFE_LOG_LEVEL`, then `warn` | `info` logs request summaries; `debug` adds headers and bodies. Known credential headers are redacted; **bodies are not**. |
| `retry?` | `Partial<RetryPolicy>` | defaults in `RetryPolicy` | |
| `timeout?` | `number` | `10000` | Milliseconds **per attempt**. There is no total retry budget. |

`debug` logging writes request bodies, meaning the full `state`, unredacted.

Source: https://docs.typesafe.ai/sdk/javascript/api/interfaces/TypeSafeClientConfig

### Environment variables (`ENV`)

```ts
const ENV: object;
```

| Key | Variable | Default when unset |
| --- | --- | --- |
| `apiKey` | `TYPESAFE_API_KEY` | none (required) |
| `baseURL` | `TYPESAFE_BASE_URL` | `https://api.typesafe.ai` |
| `defaultModel` | `TYPESAFE_DEFAULT_MODEL` | `jev-latest` |
| `logLevel` | `TYPESAFE_LOG_LEVEL` | `warn` |

The Python SDK reads the same four variable names.

Source: https://docs.typesafe.ai/sdk/javascript/api/variables/ENV, https://docs.typesafe.ai/sdk/python/api/constants

### Client properties

| Property | Type | Meaning |
| --- | --- | --- |
| `baseURL` | `readonly string` | API root with trailing slashes removed. |
| `defaultHeaders` | `readonly Readonly<Record<string, string>>` | Extra headers sent with each request. |
| `defaultModel` | `readonly string` | The model used when a request omits `model`. |
| `fetch` | `readonly Fetch` | The HTTP fetch implementation. |
| `logger` | `readonly Logger` | The configured logger, filtered to `logLevel`. |
| `logLevel` | `readonly LogLevel` | The configured log verbosity. |
| `models` | `readonly Models` | The models available to the account. |
| `retry` | `readonly RetryPolicy` | Retry settings with constructor overrides applied. |
| `timeout` | `readonly number` | Timeout per attempt in milliseconds. |

Source: https://docs.typesafe.ai/sdk/javascript/api/classes/TypeSafeClient

## Calling System One

```ts
systemOne<Q>(request, options?): APIPromise<SystemOneResult<Q>>;
```

- `Q extends Questions`.
- `request: SystemOneRequest<Q>` carries the state, the questions, and an optional model
  override.
- `options: RequestOptions = {}` carries per-call timeout, retry, headers and
  cancellation.
- It returns answers typed by question name and criteria, with the model and token
  usage.

It throws when:

1. The questions are empty, or a Score's criteria are not a list of at least two entries
   (checked on the client side).
2. The server returns a non-2xx response after retries.
3. The request cannot connect, or times out, after retries.
4. The caller aborts the request.

```ts
const { answers } = await client.systemOne({
  state: "I was charged twice. Please help.",
  questions: { billing: noul("Is this about billing?") },
});
console.log(answers.billing.noul);
```

The reference does not say which error class goes with case 1. The docs do not say
whether the client checks the 255-option Choice limit or the 10-level Score limit before
sending.

Source: https://docs.typesafe.ai/sdk/javascript/api/classes/TypeSafeClient#systemone

### `SystemOneRequest<Q>`

```ts
optional model?: string;   // Model override; omitted values inherit `defaultModel`.
questions: Q;              // Nonempty questions keyed by the names used to identify their answers.
state: EntryType;          // Text, a JSON object or array, or `null` to evaluate.
```

"Additional properties on a request variable are forwarded, including `null` values."
The SDK does not strip unknown keys, so whatever you put on the request object goes to
the server.

`SystemOneRequestPayload` extends it with a required `model: string`. It is the request
body for `POST /v1/systemone` with the model resolved.

The SDK type allows `state: null`. The HTTP reference lists `state` as required and does
not mention null.

Source: https://docs.typesafe.ai/sdk/javascript/api/interfaces/SystemOneRequest,
https://docs.typesafe.ai/sdk/javascript/api/interfaces/SystemOneRequestPayload

### `RequestOptions` (per call)

```ts
optional headers?: Record<string, string>;   // Additional headers, merged over `defaultHeaders`.
optional retry?: Partial<RetryPolicy>;       // Retry overrides for this call; omitted fields inherit client settings.
optional signal?: AbortSignal;               // Cancellation signal for the request and pending retries.
optional timeout?: number;                   // Timeout per attempt in milliseconds; there is no total retry budget.
```

Source: https://docs.typesafe.ai/sdk/javascript/api/interfaces/RequestOptions

### `SystemOneResult<Q>`

```ts
readonly answers: { readonly [K in string | number | symbol]: ResultFor<Q[K]> };
readonly model: string;   // The model used to answer the request.
readonly usage: Usage;    // Token usage for the request.
```

```ts
// Usage
readonly input_tokens: number;
readonly output_tokens: number;
```

Source: https://docs.typesafe.ai/sdk/javascript/api/interfaces/SystemOneResult,
https://docs.typesafe.ai/sdk/javascript/api/interfaces/Usage

## Question types and builders

### Builder functions

```ts
function choice<T>(instructions, criteria): ChoiceQuestion<T>;
// T extends ChoiceCriteria
// instructions: EntryType — The question as text, a JSON object or array, or `null`.
// criteria: T — Labels mapped to descriptions, or `null` for undescribed labels.

function noul(instructions?, criteria?): NoulQuestion;
// instructions?: EntryType = null
// criteria?: { false?: EntryType; true?: EntryType } | null

function score<T>(instructions, criteria): ScoreQuestion<T>;
// T extends ScoreCriteria
// criteria: T — At least two descriptions indexed by score from zero; entries may be `null`.
```

Source: https://docs.typesafe.ai/sdk/javascript/api/functions/choice,
https://docs.typesafe.ai/sdk/javascript/api/functions/noul,
https://docs.typesafe.ai/sdk/javascript/api/functions/score

### Question interfaces

```ts
// ChoiceQuestion<T extends ChoiceCriteria = ChoiceCriteria>
criteria: T;                          // Descriptions of the available outcomes.
optional instructions?: EntryType;    // The question as text, a JSON object, or an array; optional or `null`.
type: "choice";

// NoulQuestion
optional criteria?:
  | {
  false?: EntryType;
  true?: EntryType;
}
  | null;                             // Optional descriptions of the yes and no outcomes.
optional instructions?: EntryType;    // The question as text, a JSON object, or an array; optional or `null`.
type: "noul";

// ScoreQuestion<T extends ScoreCriteria = ScoreCriteria>
criteria: T;                          // Descriptions of the available outcomes.
optional instructions?: EntryType;    // The question as text, a JSON object, or an array; optional or `null`.
type: "score";

// Questions
[name: string]: Question

type Question =
  | NoulQuestion
  | ScoreQuestion
  | ChoiceQuestion;
```

In the SDK types `instructions` is optional on all three questions. The HTTP reference
marks it as required. The docs do not say what the server does with a missing or null
`instructions`.

Source: https://docs.typesafe.ai/sdk/javascript/api/interfaces/ChoiceQuestion,
https://docs.typesafe.ai/sdk/javascript/api/interfaces/NoulQuestion,
https://docs.typesafe.ai/sdk/javascript/api/interfaces/ScoreQuestion,
https://docs.typesafe.ai/sdk/javascript/api/interfaces/Questions,
https://docs.typesafe.ai/sdk/javascript/api/type-aliases/Question

### Supporting type aliases

```ts
type EntryType =
  | string
  | {
[key: string]: JsonValue;
}
  | JsonValue[]
  | null;
// Text, a JSON object or array, or `null` for state, instructions, and criteria.

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | {
[key: string]: JsonValue;
};

type ChoiceCriteria = object;
// Index signature: [label: string]: EntryType
// Labels mapped to descriptions, or `null` for undescribed labels.

type Description = EntryType;
// A criterion description; `null` leaves the label undescribed.

type ScoreCriteria = readonly [EntryType, EntryType, ...EntryType[]];
// At least two descriptions indexed by score from zero; `null` leaves a score undescribed.

type ScoreOf<T> = number extends T["length"] ? number : Extract<keyof T, `${number}`>;
type ScoreLegend<T> = { readonly [score in ScoreOf<T>]: T[score] };

type ResultFor<T> = T extends NoulQuestion ? NoulResponse : T extends ScoreQuestion<infer S> ? ScoreResponse<S> : T extends ChoiceQuestion<infer E> ? ChoiceResponse<E> : never;

type Fetch = (input, init?) => Promise<Response>;   // input: string; init?: RequestInit
type LogLevel = "debug" | "info" | "warn" | "error" | "off";
```

`ScoreCriteria` sets only the lower bound (2) in the type system. The upper bound of 10
comes from the HTTP API.

Source: https://docs.typesafe.ai/sdk/javascript/api/type-aliases/EntryType and the sibling
type-alias pages

## Response interfaces

```ts
// NoulResponse
readonly noul: number;          // Probability of a yes answer, from zero to one.
readonly type: "noul";

// ChoiceResponse<T extends ChoiceCriteria = ChoiceCriteria>
readonly choice: keyof T & string;                                              // The selected label.
readonly confidence: number;                                                   // Reported confidence in the selected label.
readonly probabilities: { readonly [label in string | number | symbol]: number };  // Probabilities keyed by label.
readonly type: "choice";

// ScoreResponse<T extends ScoreCriteria = ScoreCriteria>
readonly confidence: number;                                                   // Reported confidence in the score.
readonly legend: ScoreLegend<T>;                                               // Rubric descriptions keyed by score.
readonly probabilities: { readonly [score in number | `${number}`]: number };  // Probabilities keyed by score.
readonly score: number;                                                        // Expected score, which may fall between integer rubric levels.
readonly type: "score";
```

On the wire, Score `probabilities` and `legend` are keyed by string level numbers (`"0"`,
`"1"`, ...). The JS type accepts numeric or numeric-string keys. The Python SDK, unlike
the JS one, is documented as re-keying them by integer.

Source: https://docs.typesafe.ai/sdk/javascript/api/interfaces/NoulResponse,
https://docs.typesafe.ai/sdk/javascript/api/interfaces/ChoiceResponse,
https://docs.typesafe.ai/sdk/javascript/api/interfaces/ScoreResponse,
https://docs.typesafe.ai/primitives/score#response-structure

## `APIPromise<T>` and raw responses

`APIPromise<T>` extends `Promise<T>`. A non-2xx response rejects with an `APIError`,
including through `asResponse()`.

```ts
asResponse(): Promise<Response>;
// Resolves to the raw `Response` without parsing the body. SDK requests buffer the full
// body under the request timeout before handoff; reading it afterwards is caller-owned.
// The caller owns the body; don't also `await` the parsed result on the same promise.

map<U>(fn): APIPromise<U>;
// Transform the parsed result, sharing the HTTP response and a single body parse.

withResponse(): Promise<WithResponse<T>>;
// Return the parsed result, HTTP response, and request ID.
```

```ts
// WithResponse<T>
data: T;                           // The parsed response body.
requestId: string | undefined;     // Request ID from `x-typesafe-request-id`, or `undefined` when absent.
response: Response;                // The HTTP response, with its body consumed by parsing.
```

Source: https://docs.typesafe.ai/sdk/javascript/api/classes/APIPromise,
https://docs.typesafe.ai/sdk/javascript/api/interfaces/WithResponse

## Listing models

```ts
// Models
list(options?): APIPromise<ModelCard[]>;   // options?: RequestOptions = {}

// ModelCard
readonly description: string;
readonly name: string;
readonly release_date: string;
```

```ts
import { TypeSafeClient } from "@typesafe-ai/sdk";

const client = new TypeSafeClient();
const models = await client.models.list();
for (const model of models) {
  console.log(model.name, model.release_date, model.description);
}
```

Source: https://docs.typesafe.ai/sdk/javascript/api/interfaces/Models, https://docs.typesafe.ai/models

## Error classes

All SDK errors extend `TypeSafeError`, which extends `Error`.

```
TypeSafeError
├── APIConnectionError        request or response-body delivery failed (DNS, TLS, connection closed, etc.)
│   └── APITimeoutError       the full response did not arrive within the timeout
├── APIUserAbortError         the caller cancelled through an AbortSignal
└── APIError                  an unsuccessful HTTP response
    ├── BadRequestError           HTTP 400: the request is invalid
    ├── AuthenticationError       HTTP 401: authentication failed
    ├── PermissionDeniedError     HTTP 403: access is denied
    ├── NotFoundError             HTTP 404: the resource was not found
    ├── UnprocessableEntityError  HTTP 422: request validation failed
    ├── RateLimitError            HTTP 429: the rate limit was exceeded
    └── InternalServerError       HTTP 5xx: the server failed to handle the request
```

`APIError` (and every subclass):

```ts
new APIError(status, body, headers, message?): APIError;
readonly body: unknown;                  // Parsed JSON, response text, or `undefined` for an empty body.
readonly headers: Headers;               // HTTP response headers.
readonly requestId: string | undefined;  // Request ID from `x-typesafe-request-id`, or `undefined` when absent.
readonly status: number;                 // HTTP response status code.
static fromResponse(status, body, headers): APIError;  // Create the error subclass for an HTTP status code.
```

Extra fields on some classes:

```ts
// RateLimitError
readonly retryAfterMs: number | undefined;  // Server retry delay in milliseconds, or `undefined` when absent or invalid.

// APITimeoutError
new APITimeoutError(timeoutMs, options?): APITimeoutError;
readonly timeoutMs: number;                 // Configured timeout in milliseconds.

// APIConnectionError: message defaults to "Connection error."
// APIUserAbortError:  message defaults to "Request was aborted."
```

The HTTP API's `529 Overloaded` has no class of its own. By the "HTTP 5xx" description
it maps to `InternalServerError`.

Source: https://docs.typesafe.ai/sdk/javascript/api (class pages)

## Retry and backoff

`RetryPolicy`, with the documented defaults:

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `maxRetries` | `number` | `2` | Retries after the first attempt; `0` disables retries. |
| `httpStatuses` | `ReadonlySet<number>` | 408, 429, 500–599 | Status codes to retry. This covers 529. |
| `apiConnectionError` | `boolean` | `true` | Retry connection failures, including interrupted response bodies. |
| `apiTimeoutError` | `boolean` | `true` | Retry `APITimeoutError`. |
| `backoffInitialMs` | `number` | `500` | First backoff delay, doubled each time up to `backoffMaxMs`. |
| `backoffMaxMs` | `number` | `5000` | Maximum backoff delay. |
| `backoffJitter` | `number` | `0.25` | Fraction of each delay randomly subtracted (0 to 1). |
| `respectRetryAfter` | `boolean` | `true` | Honour `Retry-After` and `retry-after-ms`, up to `maxRetryAfterMs`. |
| `maxRetryAfterMs` | `number` | `60000` | The longest server-requested delay honoured; longer ones fall back to backoff. |

Partial overrides at the client or per call inherit the unset fields.

Worst-case wall time with the defaults: the timeout is per attempt (10 s) and there is no
total budget, so 3 attempts can take about 30 s plus the backoff delays, or longer when
the server sends a long `Retry-After` (up to 60 s is honoured). If a caller needs a hard
deadline, it has to set a lower `timeout` or `maxRetries`, or pass an `AbortSignal`. The
Python SDK has a total retry budget (`RetryPolicy.timeout`, in seconds; `None` disables
it). The JS SDK documents none.

Source: https://docs.typesafe.ai/sdk/javascript/api/interfaces/RetryPolicy,
https://docs.typesafe.ai/sdk/javascript/api/interfaces/TypeSafeClientConfig,
https://docs.typesafe.ai/sdk/python/api/retries

## Calling the HTTP API directly instead

What a direct `fetch` client has to reproduce, going by what the SDK documents:

1. **Headers**: `Authorization: Bearer <key>` and `Content-Type: application/json`.
   `POST {baseURL}/v1/systemone`, with `baseURL` defaulting to `https://api.typesafe.ai`.
2. **`model` is required** on the wire. The SDK fills in `jev-latest` (or
   `TYPESAFE_DEFAULT_MODEL`).
3. **Client-side validation** the SDK does before sending: a non-empty `questions` map,
   and Score criteria with at least two entries. Adding checks for 255 Choice options and
   10 Score levels would avoid a round trip that ends in a 422. The SDK is not documented
   as doing this.
4. **Retries**: retry 408, 429 and 5xx (including 529), connection errors and timeouts,
   with exponential backoff and jitter. Honour `retry-after` / `retry-after-ms` headers.
   The SDK defaults above are a documented baseline.
5. **Timeouts**: the SDK default is 10 s per attempt. Several cookbooks raise it to 120 s
   (a Python `timeout=120.0`) for their batch runs. The docs do not say why.
6. **Request id**: keep `x-typesafe-request-id` from the response headers for support and
   logging.
7. **Error body**: the SDK keeps it as `unknown` (parsed JSON, text, or undefined). The
   docs do not publish its schema.
8. **Browser**: the SDK refuses to run in a browser unless `dangerouslyAllowBrowser` is
   set, because the key would be exposed. A direct client in a webview has the same
   exposure.
9. **Logging**: the SDK redacts known credential headers but not bodies. A direct client
   should not log `state` without meaning to.

Source: https://docs.typesafe.ai/api, https://docs.typesafe.ai/sdk/javascript/api/classes/TypeSafeClient,
https://docs.typesafe.ai/sdk/javascript/api/interfaces/TypeSafeClientConfig,
https://docs.typesafe.ai/cookbooks/citation_check
