import { useCallback, useMemo, useState } from "react";
import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, ChevronRight, Folder, Settings2 } from "lucide-react-native";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { MenuTriggerState } from "@/components/ui/menu";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative, isWeb } from "@/constants/platform";
import { useSidebarProjectStatusBucket } from "@/hooks/use-sidebar-workspaces-list";
import type { SidebarWorkspacePlacement } from "@/hooks/sidebar-workspaces-view-model";
import type { ResolvedSidebarProjectGroup } from "@/sidebar-project-groups/model";
import type { Theme } from "@/styles/theme";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import { getStatusDotColor } from "@/utils/status-dot-color";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedFolder = withUnistyles(Folder);
const ThemedSettings = withUnistyles(Settings2);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const EMPTY_WORKSPACES: SidebarWorkspacePlacement[] = [];
const manageIcon = <ThemedSettings size={14} uniProps={mutedMapping} />;
// A j/k stop for the sidebar row navigation: it reads aria-expanded to expand and collapse the row.
const NAV_ROW_DATASET = { navRow: "true" };

/**
 * A plugin-contributed project group header. The host draws the row, tracks
 * collapse and exposes it to j/k navigation; the plugin owns the groups and
 * opens its manager through `onManage`. Group membership itself is edited in
 * the plugin's manager UI, never by dragging rows.
 */
export function SidebarProjectGroupRow({
  group,
  memberWorkspaces,
  memberCount,
  collapsed,
  onToggle,
}: {
  group: ResolvedSidebarProjectGroup;
  memberWorkspaces: readonly SidebarWorkspacePlacement[];
  memberCount: number;
  collapsed: boolean;
  onToggle: (groupKey: string) => void;
}) {
  const isCompact = useIsCompactFormFactor();
  const [isHovered, setIsHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const workspaces = useMemo(
    () => (collapsed ? memberWorkspaces : EMPTY_WORKSPACES),
    [collapsed, memberWorkspaces],
  );
  const statusBucket = useSidebarProjectStatusBucket({ workspaces, enabled: collapsed });
  const handlePress = useCallback(() => onToggle(group.key), [group.key, onToggle]);
  const handleHoverIn = useCallback(() => {
    if (!menuOpen) setIsHovered(true);
  }, [menuOpen]);
  const handleHoverOut = useCallback(() => setIsHovered(false), []);
  const handleMenuOpenChange = useCallback((open: boolean) => {
    setMenuOpen(open);
    if (open) setIsHovered(false);
  }, []);
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
  const testID = `sidebar-project-group-${group.key}`;

  return (
    <ContextMenu open={menuOpen} onOpenChange={handleMenuOpenChange}>
      <View onPointerEnter={handleHoverIn} onPointerLeave={handleHoverOut}>
        <ContextMenuTrigger
          accessibilityRole={isWeb ? undefined : "button"}
          accessibilityLabel={`${group.name} (${memberCount})`}
          accessibilityState={accessibilityState}
          aria-expanded={!collapsed}
          dataSet={NAV_ROW_DATASET}
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
              {group.name}
            </Text>
            <Text style={styles.count} testID={`${testID}-count`}>
              {memberCount}
            </Text>
          </View>
          {collapsed && statusBucket ? <GroupStatusDot bucket={statusBucket} /> : null}
        </ContextMenuTrigger>
      </View>
      <ContextMenuContent
        align="start"
        width={200}
        sheetTitle={group.name}
        testID={`sidebar-project-group-menu-${group.key}`}
      >
        {group.onManage ? (
          <ContextMenuItem
            onSelect={group.onManage}
            testID={`${testID}-manage`}
            leading={manageIcon}
          >
            <Text style={styles.menuLabel}>{group.manageLabel ?? "Manage project groups"}</Text>
          </ContextMenuItem>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}

function GroupStatusDot({ bucket }: { bucket: SidebarStateBucket }) {
  const style = DOT_STYLE[bucket];
  if (!style) return null;
  return <View style={style} testID={`sidebar-project-group-status-${bucket}`} />;
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
  menuLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  dot: { width: 7, height: 7, borderRadius: theme.borderRadius.full, marginRight: 4 },
  dotNeedsInput: { backgroundColor: getStatusDotColor({ theme, bucket: "needs_input" }) ?? "" },
  dotFailed: { backgroundColor: getStatusDotColor({ theme, bucket: "failed" }) ?? "" },
  dotRunning: { backgroundColor: getStatusDotColor({ theme, bucket: "running" }) ?? "" },
  dotAttention: { backgroundColor: getStatusDotColor({ theme, bucket: "attention" }) ?? "" },
}));

const DOT_STYLE: Partial<Record<SidebarStateBucket, StyleProp<ViewStyle>>> = {
  needs_input: [styles.dot, styles.dotNeedsInput],
  failed: [styles.dot, styles.dotFailed],
  running: [styles.dot, styles.dotRunning],
  attention: [styles.dot, styles.dotAttention],
};
