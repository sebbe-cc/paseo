import type {
  PluginInlineDecoration,
  PluginInlineDecorationTone,
  PluginInlineDecoratorContribution,
} from "@getpaseo/plugin/client";
import type { LinkRecognition } from "react-native-enriched-markdown";

const MAX_PATTERN_LENGTH = 200;
const TONES = new Set<PluginInlineDecorationTone>([
  "neutral",
  "success",
  "warning",
  "danger",
  "muted",
]);

export interface InlineDecorator {
  id: string;
  /** Source shared by JavaScript, ICU and java.util.regex; validated at registration. */
  source: string;
  inlineCode: boolean;
  /** Anchored, so a link URL maps back to the decorator that recognized it. */
  matcher: RegExp;
  resolve: PluginInlineDecoratorContribution["resolve"];
  onPress: PluginInlineDecoratorContribution["onPress"];
  subscribe(listener: () => void): () => void;
  /** Changes when `invalidate` names this text or names nothing. */
  getRevision(text: string): string;
  invalidate(texts?: readonly string[]): void;
}

export function validateInlineDecoratorPattern(id: string, pattern: unknown): string {
  if (!(pattern instanceof RegExp)) throw new Error(`Inline decorator ${id} has no pattern`);
  const { source, flags } = pattern;
  if (/[^g]/.test(flags)) {
    throw new Error(`Inline decorator ${id} pattern may only use the g flag, got: ${flags}`);
  }
  if (source.length > MAX_PATTERN_LENGTH) {
    throw new Error(`Inline decorator ${id} pattern is longer than ${MAX_PATTERN_LENGTH}`);
  }
  // Native engines reject or silently drop lookbehind; the host's own patterns own that syntax.
  if (/\(\?<[=!]/.test(source)) throw new Error(`Inline decorator ${id} pattern uses lookbehind`);
  if (new RegExp(`^(?:${source})$`).test("")) {
    throw new Error(`Inline decorator ${id} pattern matches empty text`);
  }
  return source;
}

export function createInlineDecorator(
  contribution: PluginInlineDecoratorContribution,
  id: string,
): InlineDecorator {
  const source = validateInlineDecoratorPattern(id, contribution.pattern);
  if (contribution.resolve !== undefined && typeof contribution.resolve !== "function") {
    throw new Error(`Inline decorator ${id} resolve is not a function`);
  }
  if (typeof contribution.onPress !== "function") {
    throw new Error(`Inline decorator ${id} has no onPress`);
  }
  const listeners = new Set<() => void>();
  const revisions = new Map<string, number>();
  let generation = 0;
  return {
    id,
    source,
    inlineCode: contribution.inlineCode !== false,
    matcher: new RegExp(`^(?:${source})$`),
    resolve: contribution.resolve,
    onPress: contribution.onPress,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getRevision: (text) => `${generation}:${revisions.get(text) ?? 0}`,
    invalidate(texts) {
      if (texts === undefined) {
        generation++;
        revisions.clear();
      } else {
        for (const text of texts) revisions.set(text, (revisions.get(text) ?? 0) + 1);
      }
      for (const listener of listeners) listener();
    },
  };
}

/** Decorators come first so their matches win over file paths starting at the same offset. */
export function combineLinkRecognition(
  base: { text: RegExp; inlineCode: RegExp },
  decorators: readonly InlineDecorator[],
): LinkRecognition {
  if (decorators.length === 0) return base;
  const text = decorators.map((decorator) => `(?:${decorator.source})`).join("|");
  const code = decorators
    .filter((decorator) => decorator.inlineCode)
    .map((decorator) => `(?:${decorator.source})`);
  return {
    text: new RegExp(`${text}|${base.text.source}`, "g"),
    inlineCode: code.length
      ? new RegExp(`^(?:${code.join("|")})$|${base.inlineCode.source}`)
      : base.inlineCode,
  };
}

export function findInlineDecorator<T extends { decorator: InlineDecorator }>(
  entries: readonly T[],
  url: string,
): T | undefined {
  return entries.find((entry) => entry.decorator.matcher.test(url));
}

/** `null` keeps the match as plain text; `undefined` is a link without data. */
export function resolveInlineDecoration(
  decorator: InlineDecorator,
  match: { text: string; serverId: string },
  report: (error: unknown) => void = () => undefined,
): PluginInlineDecoration | null | undefined {
  if (!decorator.resolve) return undefined;
  let result: unknown;
  try {
    result = decorator.resolve(match);
  } catch (error) {
    report(error);
    return undefined;
  }
  if (result === null) return null;
  if (typeof result !== "object" || result === undefined) return undefined;
  const value = result as Record<string, unknown>;
  const text = (key: string) =>
    typeof value[key] === "string" && value[key] ? (value[key] as string) : undefined;
  const tone = text("tone");
  return {
    label: text("label"),
    icon: text("icon"),
    tone: tone && TONES.has(tone as PluginInlineDecorationTone) ? (tone as never) : undefined,
    tooltip: text("tooltip"),
  };
}
