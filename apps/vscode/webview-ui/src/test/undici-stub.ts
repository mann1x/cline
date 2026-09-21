/**
 * Stands in for `undici` under vitest.
 *
 * `@shared/api` pulls `@cline/llms`, whose dist carries a lazy
 * `await import("undici")` to build a Node fetch agent with no body timeout.
 * `undici` is the extension host's dependency and is not installed under
 * `webview-ui`, so vite's import analysis fails while transforming a file no
 * webview test ever executes -- the import sits behind a call the webview does
 * not make.
 *
 * `Agent` is absent on purpose: the caller is written as `t.Agent ? new
 * t.Agent(...) : undefined`, so a stub with no `Agent` takes the same branch a
 * missing undici would.
 */
export {}
