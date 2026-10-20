import { Text } from "react-native";
import { useCallback, useMemo } from "react";
import { useMutation } from "@tanstack/react-query";
import { usePaseo, useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsSection,
  SettingsSelect,
} from "@getpaseo/plugin/client/ui";
import { preferences, voices, type VoiceSchema } from "../shared/preferences";
import type { z } from "zod";
import { findKing } from "../shared/king";

export function LiveSettings({ theme, navigation }: PluginSurfaceProps) {
  const settings = useSettings(preferences);
  const paseo = usePaseo();
  const king = useMutation({
    mutationFn: async () => {
      if (!navigation) throw new Error("Update Paseo to open King from this screen.");
      const agentId = await findKing(paseo);
      navigation.openAgent({ agentId });
    },
  });
  const style = useMemo(() => ({ color: theme.colors.foreground }), [theme]);
  const changeVoice = useCallback(
    (voice: z.infer<typeof VoiceSchema>) => {
      if (settings.status === "ready") void settings.save({ voice }, settings.revision);
    },
    [settings],
  );
  const openKing = useCallback(() => king.mutate(), [king]);
  if (settings.status === "loading") return <Text style={style}>Loading settings…</Text>;
  if (settings.status !== "ready")
    return (
      <SettingsSection title="Codex Live">
        <Text accessibilityRole="alert" style={style}>
          {settings.error}
        </Text>
        <SettingsAction label="Try again" actionLabel="Reload" onPress={settings.reload} />
        {settings.status === "invalid" ? (
          <SettingsAction
            label="Restore default voice"
            actionLabel="Reset"
            onPress={settings.reset}
          />
        ) : null}
        {settings.saveError ? (
          <Text accessibilityRole="alert" style={style}>
            {settings.saveError}
          </Text>
        ) : null}
      </SettingsSection>
    );
  return (
    <SettingsSection title="Codex Live">
      <SettingsCard>
        <SettingsSelect
          label="Voice"
          value={settings.values.voice}
          options={voices}
          disabled={settings.saving}
          onValueChange={changeVoice}
        />
        {navigation ? (
          <SettingsAction
            label="Gas City: King (Mayor)"
            actionLabel={king.isPending ? "Finding King…" : "Open King"}
            disabled={king.isPending}
            onPress={openKing}
          />
        ) : null}
      </SettingsCard>
      <Text style={style}>Voice changes apply the next time you start voice mode.</Text>
      {navigation ? (
        <Text style={style}>
          Open King, then use the agent’s normal voice button to talk to the Mayor.
        </Text>
      ) : null}
      {settings.saveError ? (
        <Text accessibilityRole="alert" style={style}>
          {settings.saveError}
        </Text>
      ) : null}
      {king.error ? (
        <Text accessibilityRole="alert" style={style}>
          {king.error.message}
        </Text>
      ) : null}
    </SettingsSection>
  );
}
