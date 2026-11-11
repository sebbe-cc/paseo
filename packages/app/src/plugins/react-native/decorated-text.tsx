import React, { useCallback, useMemo } from "react";
import { Text } from "react-native";
import type { DecoratedTextProps } from "@getpaseo/plugin/client/ui";
import { StyleSheet } from "react-native-unistyles";
import { isWeb } from "@/constants/platform";
import { Icon } from "../icons";
import {
  InlineDecoratorEntriesProvider,
  useInlineDecoration,
  useInlineDecorators,
} from "../inline-decorators";

/** Does not parse Markdown or recognize file paths/URLs. */
export function DecoratedText({ children, inlineCode = false, ...props }: DecoratedTextProps) {
  const { serverId, entries, press } = useInlineDecorators();
  const eligible = useMemo(
    () => entries.filter(({ decorator }) => !inlineCode || decorator.inlineCode),
    [entries, inlineCode],
  );
  const parts = useMemo(() => {
    const sources = eligible.map(({ decorator }) => `(?:${decorator.source})`);
    if (!isWeb || !sources.length) return [children];
    const result: React.ReactNode[] = [];
    let offset = 0;
    for (const match of children.matchAll(new RegExp(sources.join("|"), "g"))) {
      // Defensive progress for a pattern that matches empty only in context.
      if (!match[0]) continue;
      result.push(children.slice(offset, match.index));
      result.push(<Match key={match.index} text={match[0]} press={press} />);
      offset = match.index + match[0].length;
    }
    result.push(children.slice(offset));
    return result;
  }, [children, eligible, press]);
  return (
    <InlineDecoratorEntriesProvider serverId={serverId} entries={eligible}>
      <Text {...props}>{parts}</Text>
    </InlineDecoratorEntriesProvider>
  );
}

function Match({ text, press }: { text: string; press(text: string): boolean }) {
  const state = useInlineDecoration(text);
  const decoration = state.kind === "decorated" ? state.decoration : undefined;
  const activate = useCallback(
    (event: React.SyntheticEvent) => {
      event.preventDefault();
      event.stopPropagation();
      press(text);
    },
    [press, text],
  );
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") activate(event);
    },
    [activate],
  );
  const tone = decoration?.tone ?? "neutral";
  const color = styles[tone].color;
  const backgroundColor = styles.chip.backgroundColor;
  const fontSize = styles.chip.fontSize;
  const style = useMemo<React.CSSProperties>(
    () => ({
      borderRadius: 4,
      padding: "0 4px",
      whiteSpace: "normal",
      display: "inline-block",
      boxSizing: "border-box",
      maxWidth: "100%",
      overflowWrap: "anywhere",
      cursor: "pointer",
      fontWeight: 400,
      fontStyle: "normal",
      color,
      backgroundColor,
      fontSize,
    }),
    [color, backgroundColor, fontSize],
  );
  if (state.kind !== "decorated") return text;
  return (
    <span
      role="button"
      tabIndex={0}
      title={decoration?.tooltip}
      onClick={activate}
      onKeyDown={onKeyDown}
      style={style}
    >
      {decoration?.icon ? <Icon name={decoration.icon} size={12} /> : null}
      {decoration?.label ?? text}
    </span>
  );
}

const styles = StyleSheet.create((theme) => ({
  chip: {
    fontSize: theme.fontSize.base,
    backgroundColor: theme.colors.surface2,
  },
  neutral: { color: theme.colors.foreground },
  success: { color: theme.colors.statusSuccess },
  warning: { color: theme.colors.statusWarning },
  danger: { color: theme.colors.statusDanger },
  muted: { color: theme.colors.foregroundMuted },
}));
