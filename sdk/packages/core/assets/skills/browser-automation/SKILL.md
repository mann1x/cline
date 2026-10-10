---
name: browser-automation
description: >-
  Drives a real browser through the Playwright MCP server: opening pages,
  clicking, typing, filling forms, uploading files, reading what a page shows
  and what it requested, taking screenshots. Use when the user asks to automate
  a browser task, test a web page or flow end to end, fill in a web form, or
  get content from a page that only renders with JavaScript or behind a login.
disabled: true
---

# Browser automation with Playwright

This skill uses the tools of the Playwright MCP server. They appear as
`playwright__browser_navigate`, `playwright__browser_click` and so on, where
`playwright` is the name the server was added under. The names below leave the
prefix out.

## Before starting

If no `…__browser_navigate` tool is offered, the server is not set up. Tell the
user to add it under **MCP Servers > Add Local**, where **Playwright** is a
preset (command `npx`, argument `@playwright/mcp@latest`), then stop. Do not
try to install it or drive a browser from the shell instead.

The first call downloads the server and may download a browser, so it can take
a minute. If a call reports that the browser is not installed, say so and name
the command the message gives.

## The loop

1. `browser_navigate` to the URL.
2. `browser_snapshot`. It returns the page as an accessibility tree in which
   every element carries a reference. This is how you see the page: it is
   text, it is exact, and it is what the other tools take.
3. Act on one element: `browser_click`, `browser_type`, `browser_select_option`,
   `browser_hover`, `browser_press_key`, `browser_file_upload`.
4. Read the result the tool returns. Take a new snapshot when the page changed
   and you need references for what is on it now.

References belong to the snapshot they came from. After a navigation or any
change that redraws the page, the old ones are gone: take a new snapshot
before the next action, never reuse a reference from an earlier one.

## Naming an element

Tools that act on an element take two things:

- `target`: the element's reference copied exactly from the latest snapshot,
  or a selector that matches one element only.
- `element`: a short description in plain words ("Submit button"). It is what
  the user is shown when asked to allow the action.

Prefer the reference. Use a selector only when the snapshot does not list the
element, and make it specific enough to match once. A selector that matches
several elements is refused.

## Forms

`browser_fill_form` fills several fields in one call. Each entry needs all of
`target`, `name`, `type` and `value`. `type` is one of `textbox`, `checkbox`,
`radio`, `combobox`, `slider`. For a checkbox the value is `true` or `false`;
for a combobox it is the visible text of the option.

Fill, then snapshot and check the values took before submitting. Submit with a
click on the form's own button, or `browser_type` with `submit: true` on the
last field.

## Waiting

Do not guess with fixed delays. `browser_wait_for` takes `text` (wait until it
appears), `textGone` (until it disappears) or `time` in seconds as a last
resort. After a click that loads something, wait for a text that only the
loaded state shows.

## Reading a page

- `browser_snapshot` for what is on the page. `browser_find` searches the
  snapshot for a text or a regular expression when the page is long.
- `browser_evaluate` runs a function in the page and returns its value. Use it
  to read data the snapshot does not carry, such as a table as rows:
  `() => [...document.querySelectorAll("table tr")].map((r) => [...r.cells].map((c) => c.innerText))`
- `browser_console_messages` and `browser_network_requests` for what the page
  logged and requested; `browser_network_request` for one request's headers
  and body.
- `browser_take_screenshot` is for the user to look at, or for a model that
  reads images. You cannot act on a screenshot; act on a snapshot.

Large results take a `filename` and are saved to the workspace instead of
being returned. Use it for a long snapshot or a full-page screenshot.

For a whole site as files (pages, stylesheets, scripts, pictures), the
`web_scrape` tool is the right one when it is offered. Use the browser for
pages that need a login, a click or a form before they show their content.

## When an action is refused or does nothing

1. Take a new snapshot. The element may have moved, been replaced, or sit
   under a dialog. `browser_handle_dialog` answers an alert or a confirm.
2. Check the element is the one you mean: same text, same role.
3. Check `browser_tabs`: a link may have opened a new tab, and the tools act on
   the selected one.
4. Only then use `browser_run_code_unsafe`. It takes a function,
   `async (page) => { ... }`, and runs it with full access to the machine the
   server is on, not only to the page. Keep the snippet to the one step that
   failed, and await every call in it.

## Finishing

- Report what was done and what the page showed at the end, with the URL.
- `browser_close` when the task is over, so no browser is left open.
- Never type a password, a card number or a one-time code the user did not
  give you for this task. If a page asks for one, stop and ask.
