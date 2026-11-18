import type { MessageInputKeyboardActionKind } from "@/keyboard/actions";
import type { KeyboardActionDefinition } from "@/keyboard/keyboard-action-dispatcher";

export interface ComposerKeyboardInput {
  runKeyboardAction: (action: MessageInputKeyboardActionKind) => boolean;
}

export interface DispatchComposerKeyboardActionArgs {
  action: KeyboardActionDefinition;
  isPaneFocused: boolean;
  messageInputRef: { current: ComposerKeyboardInput | null };
  /**
   * A composer popup (slash command, mention or file autocomplete) is open. Those popups read
   * their keys in the text input, after the shortcut engine's capture listener, so the
   * interrupt must step aside for them: Escape closing a menu never cancels the turn.
   */
  isPopupOpen: () => boolean;
  isAgentRunning: boolean;
  isCancellingAgent: boolean;
  isConnected: boolean;
  handleCancelAgent: () => void;
  focusMessageInputForKeyboardAction: () => void;
}

function resolveMessageInputPassthroughAction(
  actionId: string,
): MessageInputKeyboardActionKind | null {
  switch (actionId) {
    case "message-input.send":
      return "send";
    case "message-input.dictation-confirm":
      return "dictation-confirm";
    case "message-input.dictation-toggle":
      return "dictation-toggle";
    case "message-input.dictation-cancel":
      return "dictation-cancel";
    case "message-input.voice-toggle":
      return "voice-toggle";
    case "message-input.voice-mute-toggle":
      return "voice-mute-toggle";
    default:
      return null;
  }
}

export function dispatchComposerKeyboardAction(args: DispatchComposerKeyboardActionArgs): boolean {
  const {
    action,
    isPaneFocused,
    messageInputRef,
    isPopupOpen,
    isAgentRunning,
    isCancellingAgent,
    isConnected,
    handleCancelAgent,
    focusMessageInputForKeyboardAction,
  } = args;
  if (!isPaneFocused) return false;

  if (action.id === "agent.interrupt") {
    if (messageInputRef.current?.runKeyboardAction("dictation-cancel")) return true;
    // Unhandled, so the key reaches the text input, whose open popup closes on it.
    if (isPopupOpen()) return false;
    if (!isAgentRunning || isCancellingAgent || !isConnected) return false;
    handleCancelAgent();
    return true;
  }

  if (action.id === "message-input.focus") {
    focusMessageInputForKeyboardAction();
    return true;
  }

  const passthroughAction = resolveMessageInputPassthroughAction(action.id);
  if (!passthroughAction) return false;
  const result = messageInputRef.current?.runKeyboardAction(passthroughAction);
  if (passthroughAction === "send" || passthroughAction === "dictation-confirm") {
    return result ?? false;
  }
  return true;
}
