import { Text } from "react-native";
import {
  forwardRef,
  useCallback,
  useMemo,
  useState,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
} from "react";
import type {
  CodeBlockRendererProps,
  LinkRendererProps,
  MarkdownRenderers,
} from "react-native-enriched-markdown";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useFileLink } from "@/assistant-file-links";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { HighlightedCodeBlock } from "@/components/highlighted-code-block";
import type { Theme } from "@/styles/theme";
import { useInlineDecoration } from "@/plugins/inline-decorators";
import { Icon } from "@/plugins/icons";
import type { PluginInlineDecoration, PluginInlineDecorationTone } from "@getpaseo/plugin/client";
import { MermaidFence } from "./fence/mermaid";
import { markdownLinkSource } from "./source";

const ThemedCodeBlock = withUnistyles(HighlightedCodeBlock);
const codeStyle = (theme: Theme) => ({
  inheritedStyles: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
  },
  textStyle: { backgroundColor: theme.colors.surface2, padding: 12, borderRadius: 8 },
});
function WebCodeBlock({ code, language }: CodeBlockRendererProps) {
  if (language?.toLowerCase() === "mermaid") return <MermaidFence code={code} />;
  return <ThemedCodeBlock code={code} language={language} uniProps={codeStyle} />;
}

// The library styles links inline, so a stylesheet :hover rule cannot underline them.
const LINK_HOVER_STYLE = { textDecoration: "underline" } as const;

type ChipPalette = Record<PluginInlineDecorationTone, string> & {
  background: string;
  fontSize: string;
};

interface DecorationChipProps {
  anchorProps: LinkRendererProps["anchorProps"];
  decoration: PluginInlineDecoration | undefined;
  hovered: boolean;
  palette?: ChipPalette;
  onMouseEnter(): void;
  onMouseLeave(): void;
  children: ReactNode;
}

const DecorationChip = forwardRef<HTMLAnchorElement, DecorationChipProps>(function DecorationChip(
  { anchorProps, decoration, hovered, palette, onMouseEnter, onMouseLeave, children },
  ref,
) {
  const color = palette?.[decoration?.tone ?? "neutral"];
  const style = useMemo(
    () => ({
      ...anchorProps.style,
      ...CHIP_STYLE,
      color,
      backgroundColor: palette?.background,
      fontSize: palette?.fontSize,
      ...(hovered ? LINK_HOVER_STYLE : null),
    }),
    [anchorProps.style, color, hovered, palette?.background, palette?.fontSize],
  );
  return (
    <a
      ref={ref}
      {...anchorProps}
      style={style}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {decoration?.icon ? (
        <span style={CHIP_ICON_STYLE}>
          <Icon name={decoration.icon} size={12} color={color} />
        </span>
      ) : null}
      {decoration?.label ?? children}
    </a>
  );
});
const ThemedDecorationChip = withUnistyles(DecorationChip);
const chipPalette = (theme: Theme) => ({
  palette: {
    neutral: theme.colors.foreground,
    success: theme.colors.statusSuccess,
    warning: theme.colors.statusWarning,
    danger: theme.colors.statusDanger,
    muted: theme.colors.foregroundMuted,
    background: theme.colors.surface2,
    fontSize: `${theme.fontSize.base}px`,
  },
});

function WebLink({ link, anchorProps, children }: LinkRendererProps) {
  const { tooltipPath, missing, searchedRoots, onHoverIn } = useFileLink(
    markdownLinkSource(link.url, link.sourceType),
  );
  const decoration = useInlineDecoration(link.sourceType === "markdown" ? "" : link.url);
  const [hovered, setHovered] = useState(false);
  const handleMouseEnter = useCallback(() => setHovered(true), []);
  const handleMouseLeave = useCallback(() => setHovered(false), []);
  const anchorStyle = useMemo(
    () => ({
      ...anchorProps.style,
      overflowWrap: "anywhere" as const,
      ...(hovered ? LINK_HOVER_STYLE : null),
    }),
    [anchorProps.style, hovered],
  );
  // null from resolve(): the match stays prose, not a link.
  if (decoration.kind === "text") return children;
  if (missing && decoration.kind !== "decorated") {
    // Proven missing by the daemon batch check: plain code, not a link, no
    // press — with a "saknas" mark and the searched roots as tooltip.
    // Plain DOM spans (not RN Text) take plain style objects, not unistyles.
    return (
      <Tooltip delayDuration={400}>
        <TooltipTrigger asChild>
          <InlineLinkTrigger>
            <span style={MISSING_WRAP_STYLE}>
              <code>{children}</code>
              <span style={MISSING_MARK_STYLE}> (saknas)</span>
            </span>
          </InlineLinkTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" align="start" maxWidth={520}>
          <Text selectable={false} style={styles.tooltipPath}>
            {missingTooltipText(searchedRoots)}
          </Text>
        </TooltipContent>
      </Tooltip>
    );
  }
  const chip = decoration.kind === "decorated" ? decoration.decoration : undefined;
  const tooltip = decoration.kind === "decorated" ? chip?.tooltip : tooltipPath;
  const anchor =
    decoration.kind === "decorated" ? (
      <ThemedDecorationChip
        anchorProps={anchorProps}
        decoration={chip}
        hovered={hovered}
        uniProps={chipPalette}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {children}
      </ThemedDecorationChip>
    ) : (
      <a
        {...anchorProps}
        style={anchorStyle}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {children}
      </a>
    );
  return (
    <Tooltip delayDuration={400}>
      <TooltipTrigger asChild onHoverIn={onHoverIn}>
        <InlineLinkTrigger>{anchor}</InlineLinkTrigger>
      </TooltipTrigger>
      {tooltip ? (
        <TooltipContent side="top" align="start" maxWidth={520}>
          <Text selectable={false} style={styles.tooltipPath}>
            {tooltip}
          </Text>
        </TooltipContent>
      ) : null}
    </Tooltip>
  );
}

/** Tooltip for a missing file link: where the daemon looked. */
function missingTooltipText(searchedRoots: string[]): string {
  if (searchedRoots.length === 0) {
    return "saknas";
  }
  return `saknas — sökt i: ${searchedRoots.join(", ")}`;
}

// Plain DOM spans (not RN Text) take plain style objects, not unistyles.
const MISSING_WRAP_STYLE: CSSProperties = { overflowWrap: "anywhere" };
const MISSING_MARK_STYLE: CSSProperties = { opacity: 0.65, fontSize: "0.85em" };
// TooltipTrigger also supplies native Pressable handlers; forward only DOM events.
// A View renders a div, which is invalid inside the library's prose paragraphs.
const InlineLinkTrigger = forwardRef<HTMLSpanElement, ComponentProps<"span">>(
  function InlineLinkTrigger({ children, onMouseEnter, onMouseLeave, onFocus, onBlur }, ref) {
    return (
      <span
        ref={ref}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        onFocus={onFocus}
        onBlur={onBlur}
      >
        {children}
      </span>
    );
  },
);
// A chip looks the same in bold, italics, headings and lists: it does not inherit their font.
const CHIP_STYLE = {
  borderRadius: 4,
  padding: "0 4px",
  whiteSpace: "nowrap",
  fontWeight: 400,
  fontStyle: "normal",
} as const;
const CHIP_ICON_STYLE = { display: "inline-flex", verticalAlign: "-1px", marginRight: 3 } as const;
const styles = StyleSheet.create((theme) => ({
  tooltipPath: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
}));

export const WEB_RENDERERS: MarkdownRenderers = { codeBlock: WebCodeBlock, link: WebLink };
