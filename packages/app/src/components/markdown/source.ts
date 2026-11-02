import { classifyAssistantFileLink, classifyForBatch } from "@/assistant-file-links";
import { ASSISTANT_FILE_EXTENSIONS } from "@/assistant-file-links/extensions";
import { normalizeMarkdownHtml } from "./html";
import { gfmTable } from "micromark-extension-gfm-table";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import type { AssistantFileLinkSource } from "@/assistant-file-links";
import { decodeString } from "micromark-util-decode-string";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { Link, Nodes, Paragraph, PhrasingContent, Root } from "mdast";

// Keep this regex in the syntax shared by JavaScript, ICU and java.util.regex.
// The Unicode flag makes Metro expand it to escapes rejected by native engines.
const PATH_CHARACTER = String.raw`[a-zA-Z0-9\u0080-\uFFFF_@.%+-]`;
const PATH_LETTER = String.raw`[a-zA-Z]`;
const PATH_SEGMENT = String.raw`${PATH_CHARACTER}*[a-zA-Z0-9\u0080-\uFFFF_@%+-]`;
const LINE_SUFFIX = String.raw`(?::\d+(?::\d+)?(?:-\d+(?::\d+)?)?)?`;
const FILE_EXTENSIONS = [...ASSISTANT_FILE_EXTENSIONS]
  .map((extension) => extension.replace(/[a-z]/g, (letter) => `[${letter}${letter.toUpperCase()}]`))
  .join("|");
const PATH_PREFIX = String.raw`(?:[A-Za-z]:[\\/]|\.{0,2}\/|~\/)`;
const HAS_PATH_LETTER = String.raw`(?=${PATH_CHARACTER}*(?:[\\/]${PATH_CHARACTER}*)*${PATH_LETTER})`;
const SEPARATED_PATH = String.raw`${PATH_SEGMENT}(?:[\\/]${PATH_SEGMENT})+`;
const FILE_NAME = String.raw`${PATH_SEGMENT}\.(?:${FILE_EXTENSIONS})`;
// Bare prose paths need a known extension, a line suffix, or at least two separators.
const PROSE_PATH = String.raw`(?:${PATH_PREFIX}${HAS_PATH_LETTER}${SEPARATED_PATH}|${HAS_PATH_LETTER}(?:${PATH_SEGMENT}(?:[\\/]${PATH_SEGMENT})*[\\/]${FILE_NAME}|${PATH_SEGMENT}(?:[\\/]${PATH_SEGMENT}){2,}|${SEPARATED_PATH}(?=:)))`;

function createFilePattern(path: string): RegExp {
  // The native adapter mistakes a literal + in lookbehind for a quantifier; use its hex escape.
  return new RegExp(
    String.raw`(?:${BARE_URL}|(?<![a-zA-Z0-9\u0080-\uFFFF_@.%\x2b~:/\\-])(?:${path}|${FILE_NAME})${LINE_SUFFIX}(?![a-zA-Z0-9\u0080-\uFFFF_@%+:/\\-]|\.${PATH_CHARACTER}))`,
    "g",
  );
}

// Matches bare URLs that MD4C does not autolink, like single-label or bracketed hosts.
// Quotes and unbalanced closing parentheses end the URL. Trailing sentence punctuation stays outside.
const URL_CHARACTER = String.raw`[^\s<>()"'\x60]`;
const URL_GROUP = String.raw`\(${URL_CHARACTER}*\)`;
const BARE_URL = String.raw`https?://(?:${URL_CHARACTER}|${URL_GROUP})*(?:[^\s<>()"'\x60.,;:!?]|${URL_GROUP})`;

const FILE_PATTERN = createFilePattern(PROSE_PATH);
function linkMetadata(inlineCodePaths: ReadonlySet<string>) {
  // The engine accepts regexes on both platforms. Classify complete code spans
  // first, then pass literal matches rather than maintaining a second path grammar.
  const alternatives = [...inlineCodePaths].map((path) =>
    path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  return {
    linkRecognition: {
      text: FILE_PATTERN,
      inlineCode: new RegExp(
        String.raw`^(?:https?://[^\s<>]+${alternatives.length ? `|${alternatives.join("|")}` : ""})$`,
      ),
    },
    linkSource: markdownLinkSource,
  };
}

function collectInlineCodePaths(source: string, workspaceRoot?: string): ReadonlySet<string> {
  const paths = new Set<string>();
  const previousEnds = new Map<number, number>();
  // Collect candidates between consecutive runs of equal length. The engine owns
  // Markdown context (escapes, fences, authored links); extra candidates are harmless
  // because recognition only applies to complete Code nodes. This avoids an AST
  // parse on every streaming reveal, including updates inside long code fences.
  for (const match of source.matchAll(/`+/g)) {
    const length = match[0].length;
    const previousEnd = previousEnds.get(length);
    previousEnds.set(length, match.index + length);
    if (previousEnd === undefined) continue;
    let value = source.slice(previousEnd, match.index).replace(/\r\n?|\n/g, " ");
    // CommonMark code spans replace line endings and strip one surrounding space.
    if (value.startsWith(" ") && value.endsWith(" ") && /[^ ]/.test(value)) {
      value = value.slice(1, -1);
    }
    const classification = classifyAssistantFileLink(value, { workspaceRoot });
    if (classification && classification.kind !== "external") paths.add(value);
  }
  return paths;
}

export function markdownLinkSource(
  url: string,
  sourceType?: "markdown" | "text" | "inline-code",
): AssistantFileLinkSource {
  if (sourceType === "inline-code") return { href: url, text: url, sourceType };
  if (sourceType === "text") return { href: url, text: url, markup: "linkify" };
  return { href: url, text: url };
}

/**
 * Every file-link token of a message, for the daemon batch existence check:
 * inline-code spans, authored markdown links, and linkified prose paths.
 * Sources that classify as external or ignored never become queries — the
 * batch layer asks `classifyForBatch` again per source and skips them.
 */
export function collectAssistantFileLinkSources(
  source: string,
  workspaceRoot?: string,
): AssistantFileLinkSource[] {
  const seen = new Set<string>();
  const sources: AssistantFileLinkSource[] = [];
  const push = (candidate: AssistantFileLinkSource) => {
    const key = `${candidate.sourceType ?? ""}\0${candidate.markup ?? ""}\0${candidate.href}\0${candidate.text ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    sources.push(candidate);
  };

  for (const value of collectInlineCodePaths(source, workspaceRoot)) {
    push({ href: value, text: value, sourceType: "inline-code" });
  }

  if (source.includes("](") || source.includes("]:")) {
    const tree = fromMarkdown(source, {
      extensions: [gfmTable()],
      mdastExtensions: [gfmTableFromMarkdown()],
    });
    const definitions = new Map<string, string>();
    const collectDefinitions = (node: Nodes) => {
      if (node.type === "definition" && !definitions.has(node.identifier)) {
        definitions.set(node.identifier, node.url);
      }
      if ("children" in node) node.children.forEach(collectDefinitions);
    };
    collectDefinitions(tree);
    const walk = (node: Nodes) => {
      if (
        (node.type === "link" || node.type === "linkReference") &&
        node.position?.start.offset !== undefined &&
        !node.children.some((child) => child.type === "image" || child.type === "imageReference")
      ) {
        const url = node.type === "link" ? node.url : (definitions.get(node.identifier) ?? "");
        if (url) push({ href: url, text: url });
      }
      if ("children" in node) node.children.forEach(walk);
    };
    walk(tree);
  }

  FILE_PATTERN.lastIndex = 0;
  for (const match of source.matchAll(FILE_PATTERN)) {
    const token = match[0];
    if (!token || /^https?:\/\//i.test(token)) continue;
    push({ href: token, text: token, markup: "linkify" });
  }
  FILE_PATTERN.lastIndex = 0;

  return sources.slice(0, 50);
}

// Generated by scripts/generate-markdown-image-placeholder.mjs; reserves the image box.
export const PENDING_MARKDOWN_IMAGE =
  "data:image/png;base64,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";

export interface MarkdownImage {
  source: string;
  alt: string;
  title: string | null;
  start: number;
  end: number;
}

function workspaceHoverTitle(link: Link, markup: string, workspaceRoot?: string): string | null {
  if (link.title !== null || !workspaceRoot || !link.url.startsWith(`${workspaceRoot}/`))
    return null;
  // mdast represents both missing titles and authored empty titles as null.
  if (/\s(?:""|''|\(\))\s*\)$/.test(markup)) return null;
  return link.url.slice(workspaceRoot.length + 1);
}

function inlineTextOf(node: Nodes): string {
  if (node.type === "text") return node.value;
  if (node.type === "inlineCode") return node.value;
  if ("children" in node) return node.children.map(inlineTextOf).join("");
  return "";
}

interface DeLinkTarget {
  protectedRanges: { start: number; end: number }[];
  inlineCode: { start: number; end: number; value: string }[];
  links: { start: number; end: number; url: string; label: string }[];
}

function isDeLinkProtectedType(type: string): boolean {
  return (
    type === "link" ||
    type === "linkReference" ||
    type === "image" ||
    type === "imageReference" ||
    type === "inlineCode" ||
    type === "code" ||
    type === "html" ||
    type === "definition"
  );
}

function trackDeLinkTarget(
  targets: DeLinkTarget,
  node: Nodes,
  definitions: Map<string, { url: string; title?: string | null }>,
  start: number,
  end: number,
): void {
  if (isDeLinkProtectedType(node.type)) {
    targets.protectedRanges.push({ start, end });
  }
  if (node.type === "inlineCode") {
    targets.inlineCode.push({ start, end, value: node.value });
    return;
  }
  if (node.type !== "link" && node.type !== "linkReference") {
    return;
  }
  const url = node.type === "link" ? node.url : definitions.get(node.identifier)?.url;
  const hasImage = node.children.some(
    (child) => child.type === "image" || child.type === "imageReference",
  );
  if (url && !hasImage) {
    targets.links.push({ start, end, url, label: inlineTextOf(node) });
  }
}

function collectDeLinkTargets(
  tree: Root,
  definitions: Map<string, { url: string; title?: string | null }>,
): DeLinkTarget {
  const targets: DeLinkTarget = { protectedRanges: [], inlineCode: [], links: [] };
  const walk = (node: Nodes) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) {
      if ("children" in node) node.children.forEach(walk);
      return;
    }
    trackDeLinkTarget(targets, node, definitions, start, end);
    if ("children" in node) node.children.forEach(walk);
  };
  walk(tree);
  return targets;
}

function deLinkCandidateOf(
  workspaceRoot: string | undefined,
  candidate: AssistantFileLinkSource,
): string | null {
  const batch = classifyForBatch(candidate, { workspaceRoot });
  return batch.kind === "file" ? batch.candidate : null;
}

/**
 * Native-only rewrite for daemon-proven missing file links: inline-code
 * tokens drop out of linkification and render as plain code, authored links
 * and linkified prose become code with a "saknas" mark. Only real mdast
 * node ranges are touched — backtick runs inside fences or HTML must not
 * change. Returns the surviving linkification values.
 */
function applyMissingFileDeLink(input: {
  source: string;
  tree: Root;
  definitions: Map<string, { url: string; title?: string | null }>;
  workspaceRoot?: string;
  missing: ReadonlySet<string>;
  inlineCodePaths: ReadonlySet<string>;
  edits: { start: number; end: number; text: string }[];
}): string[] {
  const candidateOf = (candidate: AssistantFileLinkSource): string | null =>
    deLinkCandidateOf(input.workspaceRoot, candidate);
  const { protectedRanges, inlineCode, links } = collectDeLinkTargets(
    input.tree,
    input.definitions,
  );
  const kept = [...input.inlineCodePaths].filter((value) => {
    const candidate = candidateOf({ href: value, text: value, sourceType: "inline-code" });
    return !candidate || !input.missing.has(candidate);
  });
  for (const target of links) {
    const candidate = candidateOf({ href: target.url, text: target.url });
    if (!candidate || !input.missing.has(candidate)) continue;
    const label = target.label.replace(/[\r\n`]+/g, " ").trim() || target.url;
    input.edits.push({
      start: target.start,
      end: target.end,
      text: `\`${label.replace(/`/g, "")}\` (saknas)`,
    });
  }
  for (const node of inlineCode) {
    const candidate = candidateOf({
      href: node.value,
      text: node.value,
      sourceType: "inline-code",
    });
    if (!candidate || !input.missing.has(candidate)) continue;
    // Skip code spans nested in links or other protected markup (not the
    // node's own range) — marking there would corrupt the label.
    const nested = protectedRanges.some(
      (range) =>
        (range.start !== node.start || range.end !== node.end) &&
        range.start <= node.start &&
        node.end <= range.end,
    );
    if (nested) continue;
    input.edits.push({ start: node.end, end: node.end, text: " (saknas)" });
  }
  FILE_PATTERN.lastIndex = 0;
  for (const match of input.source.matchAll(FILE_PATTERN)) {
    const token = match[0];
    const index = match.index;
    if (!token || /^https?:\/\//i.test(token)) continue;
    const overlaps =
      input.edits.some((edit) => index < edit.end && edit.start < index + token.length) ||
      protectedRanges.some((range) => index < range.end && range.start < index + token.length);
    if (overlaps) continue;
    const candidate = candidateOf({ href: token, text: token, markup: "linkify" });
    if (!candidate || !input.missing.has(candidate)) continue;
    input.edits.push({ start: index, end: index + token.length, text: `\`${token}\` (saknas)` });
  }
  FILE_PATTERN.lastIndex = 0;
  return kept;
}

export interface PrepareMarkdownSourceOptions {
  supportsSvg?: boolean;
  /**
   * Candidate paths the daemon batch check proved missing. With
   * `deLinkMissing` (native: no custom link renderer can restyle them)
   * missing tokens render as plain code with a "saknas" mark instead of
   * links. Web keeps the links so its custom renderer can show a tooltip
   * with the searched roots.
   */
  missingCandidatePaths?: ReadonlySet<string>;
  deLinkMissing?: boolean;
}

/** Preserve source spelling; adapt workspace images, spoiler delimiters, and entity text. */
export function prepareMarkdownSource(
  source: string,
  workspaceRoot?: string,
  options: PrepareMarkdownSourceOptions = {},
) {
  source = normalizeMarkdownHtml(source);
  const images: MarkdownImage[] = [];
  let tree: Root | undefined;
  const getTree = () =>
    (tree ??= fromMarkdown(source, {
      extensions: [gfmTable()],
      mdastExtensions: [gfmTableFromMarkdown()],
    }));
  const inlineCodePaths = collectInlineCodePaths(source, workspaceRoot);
  let metadata = linkMetadata(inlineCodePaths);
  const edits: { start: number; end: number; text: string }[] = [];
  const deLink = options.deLinkMissing === true && (options.missingCandidatePaths?.size ?? 0) > 0;
  const missingCandidates = deLink ? (options.missingCandidatePaths ?? new Set<string>()) : null;
  if (
    !deLink &&
    !source.includes("![") &&
    !source.includes("||") &&
    !source.includes("&") &&
    !(workspaceRoot && source.includes("]("))
  ) {
    return { images, ...metadata, render: () => source };
  }

  const definitions = new Map<string, { url: string; title?: string | null }>();
  function definitionsIn(node: Nodes) {
    if (node.type === "definition" && !definitions.has(node.identifier))
      definitions.set(node.identifier, node);
    if ("children" in node) node.children.forEach(definitionsIn);
  }
  definitionsIn(getTree());
  function collectImage(
    node: Extract<Nodes, { type: "image" | "imageReference" }>,
    start: number,
    end: number,
  ) {
    const target = node.type === "image" ? node : definitions.get(node.identifier);
    if (
      target &&
      options.supportsSvg === false &&
      /(?:\.svg(?:[?#]|$)|^data:image\/svg\+xml)/i.test(target.url)
    ) {
      edits.push({ start, end, text: escapeMarkdownText(node.alt ?? "") });
      return;
    }
    if (target)
      images.push({
        source: target.url,
        alt: node.alt ?? "",
        title: target.title ?? null,
        start,
        end,
      });
  }
  // Line boundaries already turned into paragraph breaks, by offset of their newline.
  const splitBoundaries = new Set<number>();
  function isImageLike(node: PhrasingContent): boolean {
    if (node.type === "image" || node.type === "imageReference") return true;
    return (
      (node.type === "link" || node.type === "linkReference") &&
      node.children.length === 1 &&
      isImageLike(node.children[0])
    );
  }
  // An image alone on its line becomes its own paragraph, so every platform renders
  // it as a block. The library only treats sole-child paragraph images as blocks;
  // with hardSoftBreaks every newline is a break node, which made these inline.
  function splitStandaloneImages(paragraph: Paragraph, start: number, end: number) {
    for (const child of paragraph.children) {
      const childStart = child.position?.start.offset;
      const childEnd = child.position?.end.offset;
      if (childStart === undefined || childEnd === undefined || !isImageLike(child)) continue;
      const lineStart = source.lastIndexOf("\n", childStart - 1) + 1;
      const newline = source.indexOf("\n", childEnd);
      const lineEnd = newline === -1 ? source.length : newline;
      const prefix = source.slice(lineStart, childStart);
      const suffix = source.slice(childEnd, lineEnd);
      const aloneBefore = childStart === start || /^[\s>]*$/.test(prefix);
      const aloneAfter = /^\s*\\?$/.test(suffix);
      if (!aloneBefore || !aloneAfter) continue;
      // Continuation lines inside quotes and lists keep their quote markers on the blank line.
      const blank = prefix.replace(/[^>]/g, " ").trimEnd();
      const split = (boundary: number) => {
        if (splitBoundaries.has(boundary)) return;
        splitBoundaries.add(boundary);
        // A trailing backslash was a hard break; at a paragraph end it would render literally.
        const cut = source[boundary - 1] === "\\" ? boundary - 1 : boundary;
        edits.push({ start: cut, end: boundary + 1, text: `\n${blank}\n` });
      };
      if (lineStart > start) split(lineStart - 1);
      if (lineEnd < end) split(lineEnd);
    }
  }
  function visit(node: Nodes) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start !== undefined && end !== undefined) {
      if (node.type === "paragraph") splitStandaloneImages(node, start, end);
      if (node.type === "link") {
        const title = workspaceHoverTitle(node, source.slice(start, end), workspaceRoot);
        if (title !== null)
          edits.push({ start: end - 1, end: end - 1, text: ` ${JSON.stringify(title)}` });
      }
      if (node.type === "tableRow") {
        // MD4C's always-enabled spoiler extension otherwise consumes adjacent cell
        // delimiters. Spaces keep empty GFM cells empty without producing spoilers.
        const row = source.slice(start, end);
        for (const match of row.matchAll(/(?<!\\)\|(?=\|)/g)) {
          edits.push({ start: start + match.index + 1, end: start + match.index + 1, text: " " });
        }
      }
      if (node.type === "image" || node.type === "imageReference") {
        collectImage(node, start, end);
        return;
      }
      if (node.type === "text") {
        const text = source
          .slice(start, end)
          .replace(/(?<!\\)&(?:#(?:[xX][\da-fA-F]+|\d+)|[a-zA-Z][a-zA-Z\d]+);/g, (entity) =>
            decodeString(entity).replace(/[!-/:-@[-`{-~]/g, "\\$&"),
          )
          .replace(/(?<!\\)\|\|/g, "\\|\\|");
        if (text !== source.slice(start, end)) edits.push({ start, end, text });
      }
    }
    if ("children" in node) node.children.forEach(visit);
  }
  visit(getTree());
  if (missingCandidates) {
    metadata = linkMetadata(
      new Set(
        applyMissingFileDeLink({
          source,
          tree: getTree(),
          definitions,
          workspaceRoot,
          missing: missingCandidates,
          inlineCodePaths,
          edits,
        }),
      ),
    );
  }
  return {
    images,
    ...metadata,
    render(
      urls: ReadonlyMap<string, string> = new Map(),
      unavailableImages: ReadonlySet<string> = new Set(),
      pendingImages: ReadonlySet<string> = new Set(),
    ) {
      const replacements = [...edits];
      for (const image of images) {
        const unavailable = unavailableImages.has(image.source);
        const pending = pendingImages.has(image.source);
        if (!unavailable && !pending && /^(https?:|data:|blob:)/i.test(image.source)) continue;
        let url = unavailable ? undefined : urls.get(image.source);
        if (pending && !unavailable) url = PENDING_MARKDOWN_IMAGE;
        replacements.push({
          start: image.start,
          end: image.end,
          text: url
            ? `![${image.alt.replace(/[[\]\\]/g, "\\$&")}](<${url}>${image.title ? ` ${JSON.stringify(image.title)}` : ""})`
            : escapeMarkdownText(image.alt),
        });
      }
      let result = source;
      for (const edit of replacements.sort((a, b) => b.start - a.start)) {
        result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
      }
      return result;
    },
  };
}

function escapeMarkdownText(text: string): string {
  return text.replace(/[!-/:-@[-`{-~]/g, "\\$&");
}
