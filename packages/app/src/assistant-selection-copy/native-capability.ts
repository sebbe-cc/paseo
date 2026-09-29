import { Platform, type PlatformOSType } from "react-native";

export function supportsNativeTimelineSelectionOn(os: PlatformOSType, version: string | number) {
  return os === "android" || (os === "ios" && Number.parseInt(String(version), 10) >= 16);
}

export const supportsNativeTimelineSelection = supportsNativeTimelineSelectionOn(
  Platform.OS,
  Platform.Version,
);
