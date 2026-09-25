import { useCallback, useMemo, useState } from "react";
import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, Folder } from "lucide-react-native";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import type { MenuTriggerState } from "@/components/ui/menu";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative, isWeb } from "@/constants/platform";
import { useSidebarProjectStatusBucket } from "@/hooks/use-sidebar-workspaces-list";
import type { SidebarWorkspacePlacement } from "@/hooks/sidebar-workspaces-view-model";
import type { MergedProjectContainer } from "@/project-containers";
import type { Theme } from "@/styles/theme";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import { getStatusDotColor } from "@/utils/status-dot-color";
import { ProjectContainerMenuItems, ProjectContainerRenameModal } from "./project-container-menu";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedFolder = withUnistyles(Folder);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const EMPTY_WORKSPACES: SidebarWorkspacePlacement[] = [];

export function ProjectContainerHeaderRow({
  container,
  containers,
  members,
  collapsed,
  onToggle,
}: {
  container: MergedProjectContainer;
  containers: readonly MergedProjectContainer[];
  members: readonly { workspaces: readonly SidebarWorkspacePlacement[] }[];
  collapsed: boolean;
  onToggle: (key: string) => void;
}) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const [isHovered, setIsHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const memberCount = members.length;
  const workspaces = useMemo(
    () => (collapsed ? members.flatMap((member) => member.workspaces) : EMPTY_WORKSPACES),
    [collapsed, members],
  );
  const statusBucket = useSidebarProjectStatusBucket({ workspaces, enabled: collapsed });
  const handlePress = useCallback(() => onToggle(container.key), [container.key, onToggle]);
  const handleHoverIn = useCallback(() => {
    if (!menuOpen) setIsHovered(true);
  }, [menuOpen]);
  const handleHoverOut = useCallback(() => setIsHovered(false), []);
  const handleMenuOpenChange = useCallback((open: boolean) => {
    setMenuOpen(open);
    if (open) setIsHovered(false);
  }, []);
  const openRename = useCallback(() => setRenaming(true), []);
  const closeRename = useCallback(() => setRenaming(false), []);
  const accessibilityState = useMemo(() => ({ expanded: !collapsed }), [collapsed]);
  const rowStyle = useCallback(
    ({ pressed, open }: MenuTriggerState) => [
      styles.row,
      (isHovered || open) && styles.rowHovered,
      pressed && styles.rowPressed,
    ],
    [isHovered],
  );
  const showChevron = isHovered || isNative || isCompact;
  const Chevron = collapsed ? ThemedChevronRight : ThemedChevronDown;
  const testID = `sidebar-project-container-${container.key}`;

  return (
    <>
      <ContextMenu open={menuOpen} onOpenChange={handleMenuOpenChange}>
        <View onPointerEnter={handleHoverIn} onPointerLeave={handleHoverOut}>
          <ContextMenuTrigger
            accessibilityRole={isWeb ? undefined : "button"}
            accessibilityLabel={t("projectContainers.headerLabel", {
              name: container.name,
              count: memberCount,
            })}
            accessibilityState={accessibilityState}
            aria-expanded={!collapsed}
            style={rowStyle}
            highlightStyle={styles.rowPressed}
            onPress={handlePress}
            testID={testID}
          >
            <View style={styles.left}>
              <View style={styles.leadingSlot}>
                {showChevron ? (
                  <Chevron size={14} uniProps={mutedMapping} />
                ) : (
                  <ThemedFolder size={14} uniProps={mutedMapping} />
                )}
              </View>
              <Text style={styles.title} numberOfLines={1}>
                {container.name}
              </Text>
              <Text style={styles.count} testID={`${testID}-count`}>
                {memberCount}
              </Text>
            </View>
            {collapsed && statusBucket ? <ContainerStatusDot bucket={statusBucket} /> : null}
          </ContextMenuTrigger>
        </View>
        <ContextMenuContent
          align="start"
          width={200}
          sheetTitle={container.name}
          testID={`sidebar-project-container-menu-${container.key}`}
        >
          <ProjectContainerMenuItems
            container={container}
            containers={containers}
            onRename={openRename}
          />
        </ContextMenuContent>
      </ContextMenu>
      {!collapsed && memberCount === 0 ? (
        <ProjectContainerEmptyRow containerKey={container.key} />
      ) : null}
      <ProjectContainerRenameModal container={container} visible={renaming} onClose={closeRename} />
    </>
  );
}

function ContainerStatusDot({ bucket }: { bucket: SidebarStateBucket }) {
  const style = DOT_STYLE[bucket];
  if (!style) return null;
  return <View style={style} testID={`project-container-status-${bucket}`} />;
}

function ProjectContainerEmptyRow({ containerKey }: { containerKey: string }) {
  const { t } = useTranslation();
  return (
    <View style={styles.emptyRow} testID={`sidebar-project-container-rows-${containerKey}`}>
      <Text style={styles.emptyText}>{t("projectContainers.empty")}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    minHeight: 36,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    marginBottom: theme.spacing[1],
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    userSelect: "none",
  },
  rowHovered: { backgroundColor: theme.colors.surfaceSidebarHover },
  rowPressed: { backgroundColor: theme.colors.surface2 },
  left: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flex: 1,
    minWidth: 0,
  },
  leadingSlot: {
    width: theme.iconSize.md,
    height: theme.iconSize.md,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: "500",
    minWidth: 0,
    flexShrink: 1,
  },
  count: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    opacity: 0.7,
  },
  dot: { width: 7, height: 7, borderRadius: theme.borderRadius.full, marginRight: 4 },
  dotNeedsInput: { backgroundColor: getStatusDotColor({ theme, bucket: "needs_input" }) ?? "" },
  dotFailed: { backgroundColor: getStatusDotColor({ theme, bucket: "failed" }) ?? "" },
  dotRunning: { backgroundColor: getStatusDotColor({ theme, bucket: "running" }) ?? "" },
  dotAttention: { backgroundColor: getStatusDotColor({ theme, bucket: "attention" }) ?? "" },
  emptyRow: {
    minHeight: 32,
    justifyContent: "center",
    paddingLeft: theme.spacing[2] + theme.iconSize.md + theme.spacing[2],
    marginBottom: theme.spacing[1],
  },
  emptyText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));

const DOT_STYLE: Partial<Record<SidebarStateBucket, StyleProp<ViewStyle>>> = {
  needs_input: [styles.dot, styles.dotNeedsInput],
  failed: [styles.dot, styles.dotFailed],
  running: [styles.dot, styles.dotRunning],
  attention: [styles.dot, styles.dotAttention],
};
