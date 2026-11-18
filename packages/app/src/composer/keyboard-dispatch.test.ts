import { describe, expect, it, vi } from "vitest";
import {
  dispatchComposerKeyboardAction,
  type DispatchComposerKeyboardActionArgs,
} from "./keyboard-dispatch";

const interrupt = { id: "agent.interrupt", scope: "global" } as const;

function escapeWhileRunning(overrides: Partial<DispatchComposerKeyboardActionArgs> = {}) {
  const handleCancelAgent = vi.fn();
  const handled = dispatchComposerKeyboardAction({
    action: interrupt,
    isPaneFocused: true,
    messageInputRef: { current: { runKeyboardAction: () => false } },
    isPopupOpen: () => false,
    isAgentRunning: true,
    isCancellingAgent: false,
    isConnected: true,
    handleCancelAgent,
    focusMessageInputForKeyboardAction: () => {},
    ...overrides,
  });
  return { handled, handleCancelAgent };
}

describe("Escape in the composer while a turn runs", () => {
  it("leaves the turn running and the key unhandled while a composer popup is open", () => {
    const { handled, handleCancelAgent } = escapeWhileRunning({ isPopupOpen: () => true });

    expect(handled).toBe(false);
    expect(handleCancelAgent).not.toHaveBeenCalled();
  });

  it("interrupts the turn when no popup is open", () => {
    const { handled, handleCancelAgent } = escapeWhileRunning();

    expect(handled).toBe(true);
    expect(handleCancelAgent).toHaveBeenCalledTimes(1);
  });

  it("cancels dictation before anything else, popup or not", () => {
    const { handled, handleCancelAgent } = escapeWhileRunning({
      isPopupOpen: () => true,
      messageInputRef: { current: { runKeyboardAction: (kind) => kind === "dictation-cancel" } },
    });

    expect(handled).toBe(true);
    expect(handleCancelAgent).not.toHaveBeenCalled();
  });
});
