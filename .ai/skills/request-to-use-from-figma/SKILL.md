---
name: request-to-use-from-figma
description: Extract a node/screen from a Figma prototype file and generate a working page (view, view model, form validation, routes) from it. Use when the user provides a Figma file key and wants a page built from a Figma design.
---

## Parameters

1. **Figma file URL or file key** — either a full Figma URL, e.g. `https://www.figma.com/design/jWozIjlRIH7yhjvGqleEwi/NRF-flows?node-id=866-14029&t=A221TfI61JzZ0077-4`, or a bare file key, e.g. `jWozIjlRIH7yhjvGqleEwi`. If given a URL, extract the file key as the path segment immediately after `/design/` or `/file/` (up to the next `/`). A `node-id` query parameter, if present, identifies a single frame/page within the file — pass it through to the extract script (see Step 1.1) so only that one page is fetched and extracted, rather than the whole file.
2. **Route ID** e.g. `file-upload`. Used as the folder name for the generated page files (`frontend/src/server/request-to-use/<route-id>`).

## Terms

- 'target folder' — the folder below `frontend/src/server/request-to-use` named after the route ID, e.g. `frontend/src/server/request-to-use/email-confirmation`

## Step 1: Extract the journey JSON

1. Run the extract script from the repo root, using the extracted file key (see Parameters above). If the input URL had a `node-id` query parameter, pass it as a second argument exactly as it appears in the URL (dashes and all — the script converts `-` to `:` itself):

   ```bash
   node .ai/skills/tools/figma/extract-journey.js <file-key> [node-id]
   ```

   When `node-id` is given, the script fetches only that single node/frame and writes a JSON object for it — it does not walk the whole file, so `nextSteps` will always be empty for this page (there's no full page list to resolve navigation targets against).

   Requires a `FIGMA_TOKEN` environment variable. If it is not set in the current shell, it may still be defined in the user's shell profile (e.g. `~/.zshrc`) but not yet loaded — try `source ~/.zshrc` (or the user's shell profile) and re-check before giving up. If it is still not set after that, stop immediately and tell the user: _"Please set the FIGMA_TOKEN environment variable and retry."_

2. **If the script fails for any reason, stop immediately.** Report the exact error to the user. Do not attempt to call the Figma API directly or guess the file structure.

3. Hold the resulting JSON object in memory.

## Step 2: Generate the page

Refer to the existing example in `frontend/src/server/request-to-use/nrl-reference` to see all the file types that should be created.
Do not create form validation, or tests - these are prototype pages.

### Create a nunjucks page

Generate a Nunjucks view file at `{target folder}/index.njk`. Use `frontend/src/server/request-to-use/nrl-reference` as an example.

The generated `index.njk` must:

- Extend `layouts/page.njk`
- Define `{% block pageTitle %}` as `{{ pageTitle }}`, or (if the page has any field-component block) `{% if validationErrors %}Error: {% endif %}{{ pageTitle }}`
- Include a `{% block beforeContent %}` with `{{ backLink({href: backLinkPath}) }}`
- **Wiring the back link and next-page destination into the wider journey is out of scope for this skill.** Where the journey JSON doesn't say what the previous or next page is (e.g. a single-node extraction, where `nextSteps` is always empty — see Step 1.1), don't ask the user to supply real route paths. Leave `backLinkPath` as the `'#'` placeholder (see "Create a view model" below) and `get-next-page.js` returning a placeholder path, and just build the page itself. Note in the summary to the user that wiring these paths into the journey needs manual follow-up.
- Wrap content in `<div class="govuk-grid-row"><div class="govuk-grid-column-two-thirds-from-desktop">…</div></div>`
- Define `{% block content %}` by converting the `content` array **in order** (see mapping below)
- For Nunjucks macro imports, check `layouts/page.njk` first; add there if missing, not in the page's own file

### Content block → markup mapping

Walk the page's `content` array in order and convert each block:

| Block shape | Output |
| --- | --- |
| `{ style: "Headings", level: 1, text, caption }` | This is the page H1 — render as `{{ pageHeading }}` (not the literal Figma text) inside `<h1 class="govuk-heading-l">`. If `caption` is present, add `<span class="govuk-caption-l">{{ caption }}</span>` immediately before it (or fold into a `govuk-fieldset__legend`/page-heading pattern if the block is really the form's legend — see Forms below) |
| `{ style: "Headings", level, text }` (not the first heading) | `<h{level} class="govuk-heading-{l\|m\|s}">{{ text }}</h{level}>` — `level: 2` → `govuk-heading-m`, `level: 3` → `govuk-heading-s` |
| `{ style: "Paragraphs", text }` | `<p class="govuk-body">{{ text }}</p>` |
| `{ style: "Links", text }` | `<p class="govuk-body"><a href="#" class="govuk-link">{{ text }}</a></p>` |
| Any other `{ component, nunjucksMacro, ...params }` | Call `{{ <nunjucksMacro>({ ...params }) }}` directly — the block's own properties already match that macro's real parameters (verified against https://design-system.service.gov.uk/components/), so pass them straight through. E.g. `{ component: "Button", nunjucksMacro: "govukButton", text: "Continue" }` → `{{ govukButton({ text: "Continue" }) }}` |

### Forms

If the page's `content` array contains any field-component block (`nunjucksMacro` one of `govukRadios`, `govukCheckboxes`, `govukInput`, `govukTextarea`, `govukSelect`, `govukDateInput`, `govukFileUpload`):

- Wrap the content in `<form method="post" novalidate>` with `{% include "partials/csrf-token.njk" %}` as the first line inside the form (see `nrl-reference/index.njk`)
- If a field's legend/label text is the same as the page H1 (common when the `Headings` block and the field's `legend`/`label` text match), use a `{% set legendHtml %}<h1 class="govuk-fieldset__heading">{{ pageHeading }}</h1>{% endset %}` and pass `legend: { html: legendHtml, classes: "govuk-fieldset__legend--l" }` instead of a separate `<h1>` — see `nrl-reference/index.njk`
- Prefix `pageTitle` with `{% if validationErrors %}Error: {% endif %}`

### Create a view model

Create `get-view-model.js` in the target folder with a named default export returning:

- `pageTitle` — `metadata.title` + `' - Gov.uk'`
- `pageHeading` — `metadata.title`
- `backLinkPath` — `'#'`

### Create a 'get next page' file (if the page has any field-component block)

Create `get-next-page.js` with a named default export function that accepts the form payload and returns the next route path. Use the page's `nextSteps` (from the journey JSON) to determine the destination — if `nextSteps` has more than one entry (a branching journey), the routing logic depends on the submitted value and should be worked out with the user rather than guessed. If `nextSteps` is empty (always the case for a single-node extraction — see Step 1.1), don't ask the user for the real destination — return a placeholder path (e.g. `'#'`) and flag it in the summary as needing manual follow-up, per the note in "Create a nunjucks page" above.

### Create a route file

Create `routes.js` — same pattern as in `frontend/src/server/request-to-use/nrl-reference`: a GET route always, a POST route if the page has a form. Route path format: `/request-to-use/<route-id>`.

Import and spread the routes into `frontend/src/server/request-to-use/index.js`.
