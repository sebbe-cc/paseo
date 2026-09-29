import { useCallback, useState, type ReactElement } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { PROJECT_CONTEXT_MAX_LENGTH } from "@getpaseo/protocol/project-container-files";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { SettingsTextAreaCard } from "@/components/settings-textarea";
import { useToast } from "@/contexts/toast-context";
import { useReportFilesError } from "./row-actions";

interface ContextVersion {
  content: string;
  updatedAt: string | null;
}

// Same draft rules as a note: a change from elsewhere replaces an untouched draft and asks
// before overwriting local edits; Save sends the version it started from.
export function ContextTab({
  client,
  containerId,
  context,
  contextUpdatedAt,
}: {
  client: DaemonClient;
  containerId: string;
  context: string;
  contextUpdatedAt: string | null;
}): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const reportError = useReportFilesError();
  const [base, setBase] = useState<ContextVersion>({
    content: context,
    updatedAt: contextUpdatedAt,
  });
  const [draft, setDraft] = useState(context);
  const [inputKey, setInputKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const dirty = draft !== base.content;
  const changed = contextUpdatedAt !== base.updatedAt;
  const reset = useCallback((next: ContextVersion) => {
    setBase(next);
    setDraft(next.content);
    setInputKey((key) => key + 1);
  }, []);
  if (!saving && !dirty && changed) reset({ content: context, updatedAt: contextUpdatedAt });
  const stale = !saving && dirty && changed;

  const handleReload = useCallback(
    () => reset({ content: context, updatedAt: contextUpdatedAt }),
    [context, contextUpdatedAt, reset],
  );
  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const result = await client.writeProjectContext({
        containerId,
        content: draft,
        expectedUpdatedAt: base.updatedAt,
      });
      setBase({ content: draft, updatedAt: result.contextUpdatedAt });
      toast.show(t("projectContainers.files.saved"), { variant: "success" });
    } catch (cause) {
      reportError(cause);
    } finally {
      setSaving(false);
    }
  }, [base.updatedAt, client, containerId, draft, reportError, t, toast]);
  const handleSavePress = useCallback(() => void handleSave(), [handleSave]);

  return (
    <SettingsSection
      title={t("projectContainers.files.context.section")}
      info={t("projectContainers.files.context.info")}
      testID="project-context-section"
    >
      {stale ? (
        <Alert
          variant="warning"
          title={t("projectContainers.files.changedElsewhere")}
          testID="project-context-stale"
        >
          <Button
            variant="outline"
            size="sm"
            onPress={handleReload}
            testID="project-context-reload"
          >
            {t("projectContainers.files.reload")}
          </Button>
        </Alert>
      ) : null}
      <SettingsTextAreaCard
        key={inputKey}
        accessibilityLabel={t("projectContainers.files.context.section")}
        value={draft}
        onChangeText={setDraft}
        placeholder={t("projectContainers.files.context.placeholder")}
        style={styles.input}
        testID="project-context-input"
      />
      <View style={styles.buttons}>
        <Button
          variant="default"
          size="sm"
          disabled={!dirty || draft.length > PROJECT_CONTEXT_MAX_LENGTH}
          loading={saving}
          onPress={handleSavePress}
          testID="project-context-save"
        >
          {t("projectContainers.files.save")}
        </Button>
      </View>
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  input: { minHeight: 320 },
  buttons: { flexDirection: "row", justifyContent: "flex-end", marginTop: theme.spacing[1] },
}));
