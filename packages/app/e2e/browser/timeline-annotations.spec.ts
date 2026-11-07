import { expect, test, type Page } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { expectComposerDraft, fillComposerDraft } from "../support/helpers/composer";

test.use({ actionTimeout: 15_000 });

const pluginDirectory = process.env.PASEO_ANNOTATE_PLUGIN_DIR;
const quote = "This exact passage deserves a comment.";

async function openAnnotation(page: Page) {
  const message = page.getByTestId("assistant-message").filter({ hasText: quote }).first();
  await expect(message).toBeVisible();
  const bounds = await message.evaluate((element, text) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      if (node.textContent?.includes(text)) break;
      node = walker.nextNode();
    }
    if (!node) throw new Error("Annotation fixture text not found");
    const start = node.textContent!.indexOf(text);
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + text.length);
    const rects = Array.from(range.getClientRects());
    const first = rects[0];
    const last = rects[rects.length - 1];
    return {
      start: { x: first.left + 1, y: first.top + first.height / 2 },
      end: { x: last.right - 1, y: last.top + last.height / 2 },
    };
  }, quote);
  await page.mouse.move(bounds.start.x, bounds.start.y);
  await page.mouse.down();
  await page.mouse.move(bounds.end.x, bounds.end.y, { steps: 12 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(quote);
  await expect(page.getByRole("menuitem", { name: "Annotate", exact: true })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+c");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(quote);
  await page.getByRole("menuitem", { name: "Annotate", exact: true }).click();
  const input = page.getByRole("textbox", { name: "Kommentar till markerad text" });
  await expect(input).toBeVisible();
  // A menu used to dismiss the newly focused input after its 150 ms keyboard timer.
  await page.waitForTimeout(200);
  await expect(input).toBeFocused();
  return input;
}

for (const width of [1100, 390]) {
  test(`actual annotation plugin creates durable attachments at ${width}px`, async ({
    page,
  }, testInfo) => {
    test.skip(
      !pluginDirectory,
      "Set PASEO_ANNOTATE_PLUGIN_DIR to the fleet paseo-annotate source directory",
    );
    test.setTimeout(120_000);
    const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
    const previous = await client.getDaemonConfig();
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "timeline-annotation-",
      title: "Timeline annotation",
      initialPrompt: "Show the annotation fixture.",
      featureValues: { mockAssistantResponse: quote },
    });
    try {
      await client.patchDaemonConfig({ pluginsEnabled: true });
      await client.installDirectoryPlugin(pluginDirectory!);
      await agent.client.waitForAgentUpsert(
        agent.agentId,
        (snapshot) => snapshot.status === "idle",
        30_000,
      );
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
      await page.setViewportSize({ width, height: 844 });
      await openAgentRoute(page, agent);
      await fillComposerDraft(page, "Preserve my draft");
      const input = await openAnnotation(page);
      await expect(page.getByRole("button", { name: "Lägg till annotering" })).toBeDisabled();
      await input.fill("Explain the first point");
      await input.press("Shift+Enter");
      await input.pressSequentially("and the second.");
      await expect(input).toHaveValue("Explain the first point\nand the second.");
      await input.evaluate((element) => {
        element.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
        );
      });
      await expect(input).toBeVisible();
      await expect(page.getByTestId("composer-plugin-resource-attachment-pill")).toHaveCount(0);
      if (width === 390) await page.getByRole("button", { name: "Lägg till annotering" }).click();
      else await input.press("Enter");
      await expect(input).toHaveCount(0);
      const pills = page.getByTestId("composer-plugin-resource-attachment-pill");
      await expect(pills).toHaveCount(1);
      await expect(pills.first()).toContainText("Explain the first point and the second.");
      await expectComposerDraft(page, "Preserve my draft");
      await expect(page.getByRole("textbox", { name: "Message agent..." }).first()).toBeFocused();
      await page.screenshot({ path: testInfo.outputPath(`annotation-attachment-${width}.png`) });

      const second = await openAnnotation(page);
      await second.fill("A separate comment");
      await second.press("Enter");
      await expect(pills).toHaveCount(2);
      await page.reload();
      await expect(pills).toHaveCount(2);
      await expectComposerDraft(page, "Preserve my draft");
      await pills.last().hover();
      await page.getByRole("button", { name: "Remove Annotate", exact: true }).last().click();
      await expect(pills).toHaveCount(1);

      await client.disablePlugin("paseo-annotate");
      await page.reload();
      await expect(pills).toHaveCount(1);
      await pills.first().click();
      const preview = page.getByText(/"kind": "paseo.timeline-annotation"/);
      await expect(preview).toContainText(quote);
      await expect(preview).toContainText(agent.agentId);
      await expect(preview).toContainText("Explain the first point\\nand the second.");
      await page.getByRole("button", { name: "Close", exact: true }).last().click();
      await fillComposerDraft(page, "");
      const send = page.getByRole("button", { name: "Send message", exact: true });
      await expect(send).toBeEnabled();
      await send.click();
      await expect(pills).toHaveCount(0);
      await expect(page.getByTestId("user-message")).toHaveCount(2);
      await expect(
        page.getByText("Explain the first point and the second.", { exact: true }).first(),
      ).toBeVisible();
    } catch (error) {
      await testInfo.attach("annotation-before-cleanup", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
      await testInfo.attach("annotation-focus", {
        body: await page.evaluate(() => document.activeElement?.outerHTML ?? "none"),
        contentType: "text/plain",
      });
      throw error;
    } finally {
      await client.removePlugin("paseo-annotate").catch(() => undefined);
      await client
        .patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled ?? false })
        .catch(() => undefined);
      await client.close();
      await agent.cleanup();
    }
  });
}
