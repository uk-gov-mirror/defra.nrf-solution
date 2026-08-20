import fs from 'fs/promises';

// 1. Validate Environment Variables and Arguments
const token = process.env.FIGMA_TOKEN;
const fileKey = process.argv[2];
// Optional third argument: a single Figma node ID to extract, e.g. "866:14029"
// (as found in a Figma URL's node-id=866-14029 query param, dash converted to colon).
// When provided, only that node is fetched and treated as a single-page journey,
// rather than fetching and walking the whole file.
const rawNodeId = process.argv[3];
const nodeId = rawNodeId?.replace('-', ':');

if (!token) {
  console.error('Error: Please set the FIGMA_TOKEN environment variable.');
  process.exit(1);
}

if (!fileKey) {
  console.error('Error: Please provide a Figma File Key as a parameter.');
  console.error('Usage: node extract-journey.js <FIGMA_FILE_KEY> [NODE_ID]');
  process.exit(1);
}

// 2. Fetch Raw Data from the Figma REST API
async function fetchFigmaFile(key) {
  const url = `https://api.figma.com/v1/files/${key}`;
  const response = await fetch(url, {
    headers: { 'X-Figma-Token': token }
  });

  if (!response.ok) {
    throw new Error(`Figma API returned status: ${response.status}`);
  }
  return response.json();
}

async function fetchFigmaNode(key, id) {
  const url = `https://api.figma.com/v1/files/${key}/nodes?ids=${id}`;
  const response = await fetch(url, {
    headers: { 'X-Figma-Token': token }
  });

  if (!response.ok) {
    throw new Error(`Figma API returned status: ${response.status}`);
  }
  const data = await response.json();
  const node = data.nodes[id];
  if (!node) {
    throw new Error(`Node ${id} was not found in file ${key}`);
  }
  return node.document;
}

// 3. Tree traversal helpers
function findChildByName(node, name) {
  return (node.children || []).find((child) => child.name === name);
}

// Figma stores manual soft line breaks (Shift+Enter within a text layer) as
// U+2028 LINE SEPARATOR inside `characters`, rather than a real paragraph
// break. Normalise to a plain space so extracted text reads naturally.
function textOf(node) {
  return node?.characters?.replace(/[\u2028\u2029]/g, ' ');
}

// Hidden nodes (and everything nested inside them) are never rendered, so
// they must never be surfaced as real content — even when searching inside
// an otherwise-visible component for a specific text/instance child.
function findFirstText(node, matcher) {
  if (node.visible === false) return null;
  if (node.type === 'TEXT' && matcher(node)) return node;
  for (const child of node.children || []) {
    const found = findFirstText(child, matcher);
    if (found) return found;
  }
  return null;
}

function findFirstInstance(node, matcher) {
  if (node.visible === false) return null;
  if (node.type === 'INSTANCE' && matcher(node)) return node;
  for (const child of node.children || []) {
    const found = findFirstInstance(child, matcher);
    if (found) return found;
  }
  return null;
}

function findAllInstances(node, matcher) {
  if (node.visible === false) return [];
  const results = node.type === 'INSTANCE' && matcher(node) ? [node] : [];
  for (const child of node.children || []) {
    results.push(...findAllInstances(child, matcher));
  }
  return results;
}

// 4. Collect top-level page frames (one per screen in the prototype)
function collectPages(document) {
  const pages = {};
  const walk = (node, parent) => {
    if (node.type === 'FRAME' && parent?.type === 'CANVAS') {
      pages[node.id] = { id: node.id, name: node.name, node };
    }
    for (const child of node.children || []) walk(child, node);
  };
  walk(document, null);
  return pages;
}

// 5. Collect real click-navigations between pages.
// Figma's legacy `transitionNodeID` field only reflects the most recently
// configured interaction (often a deprecated hover trigger baked into a
// shared component). The `interactions` array is the source of truth —
// only ON_CLICK triggers with a NAVIGATE action represent real prototype
// links between screens.
function collectNavigations(document, pageIds) {
  const navigations = {};
  const walk = (node, ownerPageId) => {
    const currentPageId = pageIds.has(node.id) ? node.id : ownerPageId;

    for (const interaction of node.interactions || []) {
      if (interaction.trigger?.type !== 'ON_CLICK') continue;
      for (const action of interaction.actions || []) {
        if (action.navigation !== 'NAVIGATE') continue;
        if (!pageIds.has(action.destinationId) || !currentPageId) continue;
        navigations[currentPageId] ??= [];
        navigations[currentPageId].push({
          triggerElement: node.name,
          triggerElementId: node.id,
          destinationPageId: action.destinationId
        });
      }
    }

    for (const child of node.children || []) walk(child, currentPageId);
  };
  walk(document, null);
  return navigations;
}

function getFlowStartIds(document) {
  const ids = [];
  for (const canvas of document.children || []) {
    if (canvas.type !== 'CANVAS') continue;
    for (const startPoint of canvas.flowStartingPoints || []) {
      ids.push(startPoint.nodeId);
    }
  }
  return ids;
}

// 6. Content extraction — maps known GOV.UK Design System component names
// to a clean, readable content block. Extend FIELD_COMPONENT_PATTERNS for
// additional form components as needed.
// Different GOV.UK Design System component versions name these layers
// differently ("Content: Label" vs plain "Label"), so match loosely.
const isHeadingText = (node) => node.name === 'Content: Heading';
const isCaptionText = (node) => node.name === 'Content: Caption';
const isBodyText = (node) => node.name === 'Content: Body';
const isLabelText = (node) =>
  node.name === 'Content: Label' || node.name === 'Label';
const isHintText = (node) =>
  node.name === 'Content: Hint' || /^Hint( text)?$/i.test(node.name);

// Component names match https://design-system.service.gov.uk/components/
// exactly, and each block's own properties match that component's real
// Nunjucks macro parameters (verified against the design system docs), so a
// downstream skill can pass a block straight into its macro call — no
// further name/shape translation needed.
function slugWords(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function slugifyKebab(text) {
  return slugWords(text).join('-');
}

function slugifyCamel(text) {
  return slugWords(text)
    .map((word, i) => (i === 0 ? word : word[0].toUpperCase() + word.slice(1)))
    .join('');
}

function extractFieldsetOptions(node) {
  const group = findFirstInstance(node, (n) => /Group$/i.test(n.name));
  const items = ((group ?? node).children || []).filter(
    (child) => /Item$/i.test(child.name) && child.visible !== false
  );
  return items
    .map((item) => textOf(findFirstText(item, isLabelText)))
    .filter(Boolean);
}

// govukRadios / govukCheckboxes: name, fieldset.legend, hint, items
function buildGroupField(component, node) {
  const legendText = textOf(findFirstText(node, isLabelText));
  const hintText = textOf(findFirstText(node, isHintText));
  return {
    component,
    name: slugifyCamel(legendText),
    fieldset: { legend: { text: legendText } },
    ...(hintText ? { hint: { text: hintText } } : {}),
    items: extractFieldsetOptions(node).map((text) => ({
      value: slugifyKebab(text),
      text
    }))
  };
}

// govukInput / govukTextarea / govukSelect: id, name, label, hint
function buildLabelField(component, node) {
  const labelText = textOf(findFirstText(node, isLabelText));
  const hintText = textOf(findFirstText(node, isHintText));
  return {
    component,
    id: slugifyKebab(labelText),
    name: slugifyCamel(labelText),
    label: { text: labelText },
    ...(hintText ? { hint: { text: hintText } } : {})
  };
}

// govukDateInput: id, namePrefix, fieldset.legend, hint
function buildDateInputField(node) {
  const legendText = textOf(findFirstText(node, isLabelText));
  const hintText = textOf(findFirstText(node, isHintText));
  return {
    component: 'Date input',
    id: slugifyKebab(legendText),
    namePrefix: slugifyCamel(legendText),
    fieldset: { legend: { text: legendText } },
    ...(hintText ? { hint: { text: hintText } } : {})
  };
}

// govukFileUpload: id, name, label, hint
function buildFileUploadField(node) {
  const labelText = textOf(findFirstText(node, isLabelText));
  // The placeholder "Hint text" node is often left as unfilled dummy
  // content; if there's a separate visible instructional body text (e.g.
  // accepted file formats), that's the real hint content.
  const hintText =
    textOf(findFirstText(node, isHintText)) ??
    textOf(findFirstText(node, isBodyText));
  return {
    component: 'File upload',
    id: slugifyKebab(labelText),
    name: slugifyCamel(labelText),
    label: { text: labelText },
    ...(hintText ? { hint: { text: hintText } } : {})
  };
}

const FIELD_COMPONENT_PATTERNS = [
  {
    match: /^Radios/i,
    component: 'Radios',
    build: (node) => buildGroupField('Radios', node)
  },
  {
    match: /^Checkboxes/i,
    component: 'Checkboxes',
    build: (node) => buildGroupField('Checkboxes', node)
  },
  {
    match: /^Text input/i,
    component: 'Text input',
    build: (node) => buildLabelField('Text input', node)
  },
  {
    match: /^Textarea/i,
    component: 'Textarea',
    build: (node) => buildLabelField('Textarea', node)
  },
  {
    match: /^Select/i,
    component: 'Select',
    build: (node) => buildLabelField('Select', node)
  },
  { match: /^Date input/i, component: 'Date input', build: buildDateInputField },
  { match: /^File upload/i, component: 'File upload', build: buildFileUploadField }
];

const FIELD_COMPONENT_NAMES = new Set(
  FIELD_COMPONENT_PATTERNS.map((pattern) => pattern.component)
);

// GOV.UK Frontend macro names mostly follow "govuk" + PascalCase(component),
// but "Text input" is the one irregular case — its macro is govukInput, not
// govukTextInput — so this is an explicit lookup rather than a derivation.
const NUNJUCKS_MACRO_NAMES = {
  'Error summary': 'govukErrorSummary',
  Panel: 'govukPanel',
  Button: 'govukButton',
  Radios: 'govukRadios',
  Checkboxes: 'govukCheckboxes',
  'Text input': 'govukInput',
  Textarea: 'govukTextarea',
  Select: 'govukSelect',
  'Date input': 'govukDateInput',
  'File upload': 'govukFileUpload'
};

function withNunjucksMacro(block) {
  const macro = block.component && NUNJUCKS_MACRO_NAMES[block.component];
  if (!macro) return block;
  const { component, ...rest } = block;
  return { component, nunjucksMacro: macro, ...rest };
}

function matchFieldComponent(name) {
  return FIELD_COMPONENT_PATTERNS.find((pattern) => pattern.match.test(name));
}

function extractErrorSummaryErrors(node) {
  return findAllInstances(node, (n) => /^Links$/i.test(n.name))
    .map((link) => textOf(findFirstText(link, () => true)))
    .filter(Boolean);
}

function buildContent(node, level = 2) {
  const blocks = [];

  for (const child of node.children || []) {
    const name = child.name;

    // Hidden nodes are never rendered — skip regardless of what they are.
    // This is the correct general signal (rather than guessing by name),
    // and also means a genuinely visible "Error summary" is kept while a
    // hidden one used only to demo a validation state is dropped.
    if (child.visible === false) continue;

    // Skip site chrome — not page content
    if (/^(Header|Footer|Phase banner|Back link)/i.test(name)) continue;

    if (/^Error summary/i.test(name)) {
      blocks.push({
        component: 'Error summary',
        titleText: textOf(findFirstText(child, isHeadingText)),
        errorList: extractErrorSummaryErrors(child).map((text) => ({ text }))
      });
      continue;
    }

    if (name === 'Headings') {
      const caption = textOf(findFirstText(child, isCaptionText));
      const heading = textOf(findFirstText(child, isHeadingText));
      if (heading) {
        blocks.push({
          style: 'Headings',
          level: 1,
          text: heading,
          ...(caption ? { caption } : {})
        });
      }
      continue;
    }

    if (/^Panel/i.test(name)) {
      blocks.push({
        component: 'Panel',
        titleText: textOf(findFirstText(child, isHeadingText)),
        text: textOf(findFirstText(child, isBodyText))
      });
      continue;
    }

    const field = matchFieldComponent(name);
    if (field) {
      blocks.push(field.build(child));
      continue;
    }

    if (/^Button/i.test(name)) {
      blocks.push({
        component: 'Button',
        text: textOf(findFirstText(child, () => true))
      });
      continue;
    }

    if (/^Links$/i.test(name)) {
      blocks.push({
        style: 'Links',
        text: textOf(findFirstText(child, () => true))
      });
      continue;
    }

    if (child.type === 'TEXT') {
      if (isHeadingText(child)) {
        blocks.push({ style: 'Headings', level, text: textOf(child) });
      } else if (child.characters) {
        blocks.push({ style: 'Paragraphs', text: textOf(child) });
      }
      continue;
    }

    // Unrecognised container: recurse to flatten the structure. This
    // includes INSTANCE, since many components (e.g. a shared "Body text"
    // wrapper) are just plain content containers rather than one of the
    // specific patterns matched above.
    if (
      child.type === 'FRAME' ||
      child.type === 'GROUP' ||
      child.type === 'INSTANCE'
    ) {
      blocks.push(...buildContent(child, level));
    }
  }

  return blocks;
}

function pageTypeFor(content) {
  if (content.some((block) => block.component === 'Panel')) return 'confirmation';
  if (content.some((block) => FIELD_COMPONENT_NAMES.has(block.component))) {
    return 'form';
  }
  return 'content';
}

function titleFor(content) {
  const first = content.find(
    (block) =>
      block.component === 'Panel' ||
      (block.style === 'Headings' && block.level === 1)
  );
  if (!first) return null;
  return first.component === 'Panel' ? first.titleText : first.text;
}

// 7. Order pages by following the navigation graph from the flow starting
// point(s), so the output reads as a journey rather than a random page list.
function orderPageIds(pages, navigations, startIds) {
  const ordered = [];
  const visited = new Set();

  const visit = (id) => {
    if (!id || visited.has(id) || !pages[id]) return;
    visited.add(id);
    ordered.push(id);
    for (const nav of navigations[id] || []) visit(nav.destinationPageId);
  };

  for (const id of startIds) visit(id);
  for (const id of Object.keys(pages)) visit(id); // append any orphan pages

  return ordered;
}

// 8. Assemble the journey
function buildJourney(document) {
  const pages = collectPages(document);
  const pageIds = new Set(Object.keys(pages));
  const navigations = collectNavigations(document, pageIds);
  const startIds = getFlowStartIds(document);
  const orderedIds = orderPageIds(
    pages,
    navigations,
    startIds.length ? startIds : [Object.keys(pages)[0]]
  );

  return orderedIds.map((id) => {
    const page = pages[id];
    const main = findChildByName(page.node, 'Main') || page.node;
    const content = buildContent(main).map(withNunjucksMacro);

    return {
      metadata: {
        urlPath: page.name,
        title: titleFor(content),
        pageType: pageTypeFor(content)
      },
      content,
      nextSteps: (navigations[id] || []).map((nav) => ({
        action: nav.triggerElement,
        goToPage: pages[nav.destinationPageId]?.name ?? 'Unknown page'
      }))
    };
  });
}

// 8b. Build a single-page journey from one directly-fetched node. Skips the
// full-file navigation walk (collectPages/collectNavigations require the
// whole document tree to resolve page names), so nextSteps is always empty
// here — the calling skill already treats multi-destination navigation as
// something to work out with the user rather than infer.
function buildSinglePageJourney(node) {
  const main = findChildByName(node, 'Main') || node;
  const content = buildContent(main).map(withNunjucksMacro);

  return [
    {
      metadata: {
        urlPath: node.name,
        title: titleFor(content),
        pageType: pageTypeFor(content)
      },
      content,
      nextSteps: []
    }
  ];
}

// Main Execution
async function main() {
  try {
    if (nodeId) {
      console.log(`Fetching Figma node: ${nodeId} from file ${fileKey}...`);
      const node = await fetchFigmaNode(fileKey, nodeId);

      console.log('Extracting page content...');
      const journey = buildSinglePageJourney(node);

      const outputPath = './figma-journey.json';
      await fs.writeFile(outputPath, JSON.stringify(journey, null, 2));
      console.log(`Success! Journey data exported to ${outputPath}`);
      return;
    }

    console.log(`Fetching Figma file: ${fileKey}...`);
    const fileData = await fetchFigmaFile(fileKey);

    console.log('Extracting pages, content and navigation...');
    const journey = buildJourney(fileData.document);

    const outputPath = './figma-journey.json';
    await fs.writeFile(outputPath, JSON.stringify(journey, null, 2));
    console.log(`Success! Journey data exported to ${outputPath}`);
  } catch (error) {
    console.error('Pipeline failed:', error.message);
    process.exit(1);
  }
}

main();
