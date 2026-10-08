import { Text, type TextProps } from "react-native";

export function SelectableText(props: TextProps) {
  return <Text {...props} selectable />;
}
