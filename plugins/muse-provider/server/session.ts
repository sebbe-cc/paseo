import type {
  ProviderEvent,
  ProviderInput,
  ProviderLaunch,
  ProviderPersistence,
  ProviderSessionConfig,
  ProviderConfigChanges,
  ProviderPrompt,
  ProviderPermissionResponse,
  ProviderMcpServerConfig,
  ProviderCatalog,
  ProviderToolCallDetail,
} from "@getpaseo/plugin/server/provider";
import type { z } from "zod";
import { MspConnection, commandId, type Notification } from "./connection.js";
import { IdleHost } from "./idle-host.js";
import { MuseError, actionableError } from "./errors.js";
import { Timeline, todoItem } from "./timeline.js";
import { modes, efforts, presentCatalog } from "./catalog.js";
import {
  pendingSchema,
  itemNotificationSchema,
  approvalResolvedSchema,
  usageSchema,
  ackSchema,
  gapSchema,
  catalogSchema,
  approvalModeSchema,
  approvalSchema,
  deltaSchema,
  effortSchema,
  notificationSchema,
  persistenceSchema,
  promptResultSchema,
  sessionReadSchema,
  sessionSchema,
  turnSchema,
  tokenUsageSchema,
  contextUsageSchema,
  type WireItem,
  type WireApproval,
} from "./wire.js";
import type { SessionMcpServerConfig, TurnStartParams } from "./msp.js";

import { Children } from "./children.js";
import { Recovery } from "./recovery.js";
import { Questions } from "./questions.js";
import { Commands } from "./commands.js";

interface SessionOptions {
  serveArgs: string[];
  id: string;
  config: ProviderSessionConfig;
  launch: ProviderLaunch;
  emit(event: ProviderEvent): void;
  capabilities: readonly string[];
}

interface Live {
  nativeId: string;
  timeline: Timeline;
  children: Children;
  questions: Questions;
  commands: Commands;
  recovery: Recovery;
}

export class Session {
  private readonly host: IdleHost;
  private liveState: Live | undefined;
  private providerId: string | undefined;
  private config: ProviderSessionConfig;
  private catalog: ProviderCatalog = { models: [], modes };
  private readonly approvals = new Map<string, WireApproval>();
  private readonly messages = new Map<string, string>();
  private readonly turns = new Map<string, "active" | "completed">();
  private notifications: Promise<void> = Promise.resolve();
  private readonly buffered: Notification[] = [];
  private opening = true;
  private closing = false;
  private firstTurn = true;
  private interruptCompletion: {
    turnId: string;
    resolve(): void;
    reject(error: Error): void;
  } | null = null;

  constructor(private readonly options: SessionOptions) {
    this.config = options.config;
    this.host = new IdleHost(
      () =>
        new MspConnection({
          launch: { ...options.launch, env: { ...options.launch.env, ...options.config.env } },
          cwd: options.config.cwd,
          serveArgs: options.serveArgs,
        }),
    );
    this.host.onNotification((notification) => {
      if (this.opening) this.buffered.push(notification);
      else this.enqueue(notification);
    });
    this.host.onExit((error) => {
      if (!this.opening && !this.closing) this.runtimeFailed(error);
    });
  }

  async open(input: Extract<ProviderInput, { type: "session.open" }>): Promise<void> {
    await this.host.initialize();
    const mcpServers = this.mcpServers();
    let response;
    if (input.persistence) {
      if (input.persistence.version !== 1)
        throw new MuseError("invalidPersistence", "Unsupported Muse persistence version");
      const saved = persistenceSchema.parse(input.persistence.data);
      // A fresh timeline needs history. MSP cursor resumes return only the suffix,
      // so even legacy persistence cursors cannot restore this session's projection.
      response = await this.host.command(
        "session/resume",
        { sessionId: saved.sessionId, config: { mcpServers } },
        sessionSchema,
      );
      this.config = {
        ...this.config,
        model: this.config.model ?? saved.model,
        thinkingOption: this.config.thinkingOption ?? saved.thinkingOption,
      };
      this.firstTurn = false;
    } else {
      response = await this.host.command(
        "session/start",
        {
          workspaceRoot: this.config.cwd,
          modelId: this.config.model,
          approvalMode: approvalModeSchema.parse(this.config.mode ?? "onRequest"),
          config: { mcpServers },
        },
        sessionSchema,
      );
    }
    if (!response.viewCursor)
      throw new MuseError(
        "emptyViewCursor",
        "Muse returned an empty resume viewCursor; this session cannot be watched.",
      );
    const nativeId = response.session.sessionId;
    this.liveState = {
      nativeId,
      children: new Children(this.host, this.options.id, this.config.cwd, this.options.emit),
      timeline: new Timeline(
        this.host,
        nativeId,
        this.options.id,
        this.options.emit,
        (messageCommandId) => this.messages.get(messageCommandId),
      ),
      questions: new Questions(this.host, nativeId, this.options.id, this.options.emit),
      commands: new Commands(this.host, nativeId, this.options.id, this.options.emit),
      recovery: new Recovery(
        this.host,
        nativeId,
        response.viewCursor,
        (event) => this.notify(event, "backfill"),
        () => {
          this.notifications = this.notifications
            .then(async () => {
              const live = this.live();
              await live.recovery.backfill();
              return live.children.refresh();
            })
            .catch((error) => this.runtimeFailed(error));
        },
      ),
    };
    this.providerId = response.session.providerId ?? undefined;
    this.config = {
      ...this.config,
      model: response.session.modelId ?? this.config.model,
      mode: response.session.approvalMode?.mode ?? this.config.mode ?? "onRequest",
    };
    this.options.emit({
      type: "session.opened",
      requestId: input.requestId,
      sessionId: this.options.id,
      cwd: this.config.cwd,
      restoration: "core",
      capabilities: this.options.capabilities,
      persistence: this.persistence(),
    });
    if (input.history === "replay" && response.history?.mode === "inline") {
      if (!response.history.items)
        throw new MuseError("invalidHistory", "Muse inline history has no items");
      for (const item of response.history.items) await this.fold(item);
    }
    await this.restorePending(response.pendingRequests);
    // Inline history precedes suffix events; replayed turn terminals do not own a fresh run.
    this.opening = false;
    for (const notification of this.buffered) this.enqueue(notification);
    this.buffered.length = 0;
    await this.notifications;
    await this.readCatalog();
    await this.live().commands.refresh();
    this.publishPersistence();
    this.publishConfig();
    this.options.emit({
      type: "session.ready",
      requestId: input.requestId,
      sessionId: this.options.id,
    });
    this.host.arm({ reopen: (host) => this.reattach(host), busy: (host) => this.busy(host) });
  }

  get awake(): boolean {
    return this.host.awake;
  }
  private mcpServers(): Record<string, SessionMcpServerConfig> {
    return Object.fromEntries(
      Object.entries(this.config.mcpServers).map(([id, server]) => [id, mcpServer(server)]),
    );
  }
  // The idle host ran no turn, so the timeline is current; only the view cursor is new.
  private async reattach(host: MspConnection): Promise<void> {
    await host.initialize();
    const response = await host.command(
      "session/resume",
      { sessionId: this.live().nativeId, config: { mcpServers: this.mcpServers() } },
      sessionSchema,
    );
    if (response.viewCursor) this.live().recovery.activity(response.viewCursor, false);
  }
  private async busy(host: MspConnection): Promise<boolean> {
    if (this.closing || this.activeTurnIds().length > 0 || this.approvals.size > 0) return true;
    try {
      const read = await host.request(
        "session/read",
        { sessionId: this.live().nativeId },
        sessionReadSchema,
      );
      return read.session.activeTurnId !== null;
    } catch {
      return true;
    }
  }

  private live(): Live {
    if (!this.liveState) throw new MuseError("sessionNotOpen", "Muse session is not open");
    return this.liveState;
  }

  private async restorePending(
    pointers: z.infer<typeof sessionSchema>["pendingRequests"],
  ): Promise<void> {
    if (!pointers.some((pending) => ["approval", "userInput"].includes(pending.kind))) return;
    const pending = await this.host.request(
      "approval/listPending",
      { sessionId: this.live().nativeId },
      pendingSchema,
    );
    for (const approval of pending.approvals) await this.permission(approval);
    for (const question of pending.userInputs) this.live().questions.requested(question);
  }
  private async readCatalog(): Promise<void> {
    this.catalog = presentCatalog(
      await this.host.request("model/list", { sessionId: this.live().nativeId }, catalogSchema),
    );
    const model = this.config.model ?? this.catalog.defaultModel;
    const selected = this.catalog.models.find((entry) => entry.id === model);
    this.config = {
      ...this.config,
      model,
      thinkingOption: this.config.thinkingOption ?? selected?.defaultThinkingOptionId,
    };
  }

  async prompt(prompt: ProviderPrompt): Promise<void> {
    if (await this.live().commands.compact(prompt)) return;
    const id = commandId();
    this.messages.set(id, prompt.clientMessageId);
    const input: TurnStartParams["input"] = [];
    const text: string[] = [];
    if (this.firstTurn && this.config.systemPrompt)
      input.push({
        type: "text",
        text: `<system_instructions>\n${this.config.systemPrompt}\n</system_instructions>`,
      });
    if (prompt.input.type === "command") {
      input.push(this.live().commands.input(prompt.input));
      text.push(
        `/${prompt.input.name}${prompt.input.arguments ? ` ${prompt.input.arguments}` : ""}`,
      );
    } else
      for (const part of prompt.input.content) {
        if (part.type === "text") {
          input.push({ type: "text", text: part.text });
          text.push(part.text);
        } else if (part.type === "image")
          input.push({ type: "image", base64Data: part.data, mediaType: part.mimeType });
        else throw new MuseError("unsupported", `Muse does not support ${part.type} attachments`);
      }
    const params: TurnStartParams = {
      commandId: id,
      sessionId: this.live().nativeId,
      input,
      displayText: text.join("\n"),
      ifBusy: prompt.delivery === "steer" ? "steer" : "queue",
      reasoningEffort: this.config.thinkingOption
        ? effortSchema.parse(this.config.thinkingOption)
        : undefined,
    };
    const response = await this.host.command("turn/start", params, promptResultSchema);
    this.firstTurn = false;
    if (response.disposition === "started" && this.turns.get(response.turnId) !== "completed")
      this.turns.set(response.turnId, "active");
    this.live().recovery.activity(undefined, this.activeTurnIds().length > 0);
    const type = response.disposition === "steered" ? "steer" : "turn";
    this.options.emit({
      type: "session.prompt_result",
      sessionId: this.options.id,
      clientMessageId: prompt.clientMessageId,
      result: { type, turnId: response.turnId },
    });
  }
  async configure(changes: ProviderConfigChanges): Promise<void> {
    if (changes.model !== undefined) {
      if (!changes.model) throw new MuseError("invalidModel", "Choose a Muse model");
      await this.host.command(
        "session/setModel",
        {
          sessionId: this.live().nativeId,
          model: { providerId: this.providerId, modelId: changes.model },
        },
        ackSchema,
      );
      this.config = { ...this.config, model: changes.model };
    }
    // Muse receives configured thinking effort on each turn/start, rather than a session mutation.
    if (changes.thinkingOption !== undefined) {
      const thinkingOption =
        changes.thinkingOption === null ? undefined : effortSchema.parse(changes.thinkingOption);
      this.config = { ...this.config, thinkingOption };
    }
    if (changes.mode !== undefined) {
      const mode = approvalModeSchema.parse(changes.mode ?? "onRequest");
      await this.host.command(
        "session/setApprovalMode",
        { sessionId: this.live().nativeId, mode },
        ackSchema,
      );
      this.config = { ...this.config, mode };
    }
    this.publishConfig();
    this.publishPersistence();
  }
  async answer(permissionId: string, response: ProviderPermissionResponse): Promise<void> {
    if (await this.live().questions.answer(permissionId, response)) return;
    const approval = this.approvals.get(permissionId);
    if (!approval)
      throw new MuseError("approvalNotFound", "This Muse approval is no longer pending");
    const choice = response.selectedActionId
      ? approval.availableChoices.find(
          (candidate) => candidate.choiceId === response.selectedActionId,
        )
      : (approval.availableChoices.find((candidate) =>
          response.behavior === "allow"
            ? candidate.decision === "approved" && candidate.scope === "once"
            : candidate.decision === "denied" && candidate.scope === "once",
        ) ??
        (response.behavior === "deny"
          ? approval.availableChoices.find(
              (candidate) => candidate.decision === "abort" && candidate.scope === "once",
            )
          : undefined));
    if (!choice)
      throw new MuseError(
        "invalidApprovalChoice",
        "Choose one of Muse's available approval actions",
      );
    await this.decide(approval, choice.choiceId);
  }
  private async decide(approval: WireApproval, choiceId: string): Promise<void> {
    await this.host.command(
      "approval/decide",
      {
        sessionId: this.live().nativeId,
        approvalId: approval.approvalId,
        choiceId,
        requirementId: approval.currentRequirementId,
      },
      ackSchema,
    );
  }
  async readUsage() {
    return this.host.request("usage/read", {}, usageSchema);
  }
  async interrupt(): Promise<void> {
    let turnId = this.activeTurnIds().at(-1);
    if (!turnId) {
      // Local bookkeeping may have lost a still-running native turn (a
      // backfilled terminal applied while the live stream was down). Confirm
      // with the host before giving up: without this the cancel is a silent
      // no-op and the run continues behind Paseo's back.
      turnId = (await this.nativeActiveTurnId()) ?? undefined;
      if (!turnId) return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const completion = new Promise<void>((resolve, reject) => {
      this.interruptCompletion = { turnId, resolve, reject };
      timer = setTimeout(() => {
        this.runtimeFailed(
          new MuseError(
            "interruptTimeout",
            "Muse did not confirm cancellation within 10000ms. Reopen the session before sending another prompt.",
          ),
        );
        // The interrupt timeout already failed the session; a slow host
        // shutdown must never surface as an unhandled rejection (it crashed
        // the daemon). Swallow it here; close() callers still see failures.
        void this.host.close().catch(() => {});
      }, 10000);
    });
    try {
      await Promise.all([
        this.host.command("turn/interrupt", { sessionId: this.live().nativeId, turnId }, ackSchema),
        completion,
      ]);
    } finally {
      clearTimeout(timer!);
      this.interruptCompletion = null;
    }
  }
  async close(): Promise<void> {
    this.closing = true;
    if (this.liveState) this.live().recovery.close();
    await this.host.close();
    await this.notifications;
    if (this.liveState) this.live().children.close();
  }
  private enqueue(notification: Notification): void {
    this.notifications = this.notifications
      .then(() => this.notify(notification))
      .catch((error: unknown) => this.runtimeFailed(error));
  }
  private runtimeFailed(error: unknown): void {
    this.live().recovery.close();
    this.options.emit({
      type: "session.runtime_failed",
      sessionId: this.options.id,
      error: actionableError(error, this.options.launch),
    });
    const interrupt = this.interruptCompletion;
    if (interrupt) interrupt.reject(error instanceof Error ? error : new Error(String(error)));
  }
  private async notify(
    notification: Notification,
    origin: "live" | "backfill" = "live",
  ): Promise<void> {
    const envelope = notificationSchema.parse(notification.params);
    if (envelope.sessionId && envelope.sessionId !== this.live().nativeId) {
      await this.live().children.notify(envelope.sessionId, notification);
      return;
    }
    await this.processNotification(notification, origin);
    this.live().recovery.activity(envelope.viewCursor, this.activeTurnIds().length > 0);
  }
  private async processNotification(
    notification: Notification,
    origin: "live" | "backfill" = "live",
  ): Promise<void> {
    switch (notification.method) {
      case "view/gap":
        // The gap lower bound remains authoritative even if a later live event arrived first.
        await this.live().recovery.backfill(gapSchema.parse(notification.params).after);
        break;
      case "userInput/requested":
        this.live().questions.requested(notification.params);
        break;
      case "userInput/settled":
        this.live().questions.resolved(notification.params);
        break;
      case "session/todoListChanged":
        this.options.emit({
          type: "timeline.item",
          sessionId: this.options.id,
          item: todoItem(notification.params),
        });
        break;
      case "skill/changed":
        await this.live().commands.refresh();
        break;
      case "item/started":
      case "item/updated":
      case "item/completed": {
        const params = itemNotificationSchema.parse(notification.params);
        await this.fold(params.item);
        break;
      }
      case "item/delta":
        this.live().timeline.delta(deltaSchema.parse(notification.params));
        break;
      case "approval/requested":
      case "approval/updated":
        await this.permission(approvalSchema.parse(notification.params));
        break;
      case "approval/resolved": {
        const params = approvalResolvedSchema.parse(notification.params);
        this.approvals.delete(params.approvalId);
        this.options.emit({
          type: "session.permission_resolved",
          sessionId: this.options.id,
          permissionId: params.approvalId,
        });
        break;
      }
      case "turn/started":
        this.startTurn(notification.params);
        break;
      case "turn/completed":
        await this.completeTurn(notification.params, origin);
        break;
      case "session/tokenUsage": {
        const params = tokenUsageSchema.parse(notification.params);
        this.options.emit({
          type: "session.usage",
          sessionId: this.options.id,
          usage: {
            inputTokens: params.cumulative.promptTokens,
            outputTokens: params.cumulative.outputTokens,
            cachedInputTokens: params.usage?.cachedTokens,
          },
        });
        break;
      }
      case "session/contextUsage": {
        const params = contextUsageSchema.parse(notification.params);
        this.options.emit({
          type: "session.usage",
          sessionId: this.options.id,
          usage: {
            contextWindowUsedTokens: params.usedTokens,
            contextWindowMaxTokens: params.windowTokens,
          },
        });
        break;
      }
    }
  }
  private startTurn(input: unknown): void {
    const params = turnSchema.parse(input);
    if (
      params.commandId &&
      this.messages.has(params.commandId) &&
      this.turns.get(params.turnId) !== "completed"
    ) {
      this.turns.set(params.turnId, "active");
      this.options.emit({
        type: "session.turn",
        sessionId: this.options.id,
        turnId: params.turnId,
        state: "started",
      });
    }
  }
  private activeTurnIds(): string[] {
    return [...this.turns].filter(([, state]) => state === "active").map(([id]) => id);
  }
  private async nativeActiveTurnId(): Promise<string | null> {
    if (!this.liveState || this.closing) return null;
    try {
      const read = await this.host.request(
        "session/read",
        { sessionId: this.live().nativeId },
        sessionReadSchema,
      );
      return read.session.activeTurnId;
    } catch {
      return null;
    }
  }
  private async nativeTurnStillActive(turnId: string): Promise<boolean> {
    return (await this.nativeActiveTurnId()) === turnId;
  }
  private async completeTurn(input: unknown, origin: "live" | "backfill"): Promise<void> {
    const params = turnSchema.parse(input);
    if (this.turns.get(params.turnId) !== "active") {
      // A live terminal always owns the run it names: release a racing
      // interrupt even when local bookkeeping already lost the turn.
      if (origin === "live" && this.interruptCompletion?.turnId === params.turnId)
        this.interruptCompletion.resolve();
      return;
    }
    if (origin === "backfill" && (await this.nativeTurnStillActive(params.turnId))) {
      // The silence/gap repair replayed a terminal for a run the host still
      // considers active. Accepting it would fail the turn while Muse keeps
      // working and lose the run for later interrupts (phantom
      // "Muse turn failed"). Keep the turn active; the live terminal will
      // complete it when the run really ends.
      console.warn(
        `[muse-provider] ignoring backfilled turn/completed for still-active native turn ${params.turnId}: ${JSON.stringify(params)}`,
      );
      return;
    }
    this.turns.set(params.turnId, "completed");
    let state: "completed" | "canceled" | "failed" = "completed";
    let error;
    if (params.terminal === "cancelled") state = "canceled";
    else if (params.error || params.terminal === "failed") {
      state = "failed";
      error = params.error
        ? actionableError(
            new MuseError(params.error.kind, params.error.message),
            this.options.launch,
          )
        : { message: "Muse turn failed" };
    }
    this.options.emit({
      type: "session.turn",
      sessionId: this.options.id,
      turnId: params.turnId,
      state,
      error,
    });
    if (this.interruptCompletion?.turnId === params.turnId) this.interruptCompletion.resolve();
  }

  private async fold(item: WireItem): Promise<void> {
    if (await this.live().timeline.fold(item)) await this.live().children.update(item);
  }
  private async permission(approval: WireApproval): Promise<void> {
    const current = approval.subject.stages.find(
      (stage) => stage.requirementId.sourceIndex === approval.currentRequirementId?.sourceIndex,
    );
    if (current && current.resolution.kind !== "unresolved") return;
    this.approvals.set(approval.approvalId, approval);
    if (this.config.mode === "allowAll") {
      const choice = approval.availableChoices.find(
        (candidate) => candidate.decision === "approved" && candidate.scope === "once",
      );
      if (!choice)
        throw new MuseError("noAllowOnceChoice", "Muse escalation has no allow-once action");
      await this.decide(approval, choice.choiceId);
      return;
    }
    let title = approval.toolName;
    if (current) title = `Stage ${current.position} of ${current.totalStages}`;
    let detail: ProviderToolCallDetail;
    const subject = approval.subject;
    if (subject.kind === "shell")
      detail = {
        type: "shell",
        command: current ? current.argv.join(" ") : subject.command,
        cwd: subject.workspaceRoot,
      };
    else if (subject.kind === "fileAccess") detail = { type: "edit", filePath: subject.path };
    else
      detail = {
        type: "plain_text",
        label: subject.kind,
        text: subject.host || subject.path || subject.command,
      };
    const actions = approval.availableChoices.map((choice) => {
      const behavior = choice.decision.startsWith("approved") ? "allow" : "deny";
      return { id: choice.choiceId, label: choice.label, behavior } as const;
    });
    this.options.emit({
      type: "session.permission",
      sessionId: this.options.id,
      request: {
        id: approval.approvalId,
        name: approval.toolName,
        kind: "tool",
        title,
        detail,
        actions,
      },
    });
  }
  private persistence(): ProviderPersistence {
    return {
      version: 1,
      data: {
        sessionId: this.live().nativeId,
        ...(this.config.model ? { model: this.config.model } : {}),
        ...(this.config.thinkingOption ? { thinkingOption: this.config.thinkingOption } : {}),
      },
    };
  }
  private publishPersistence(): void {
    this.options.emit({
      type: "session.persistence",
      sessionId: this.options.id,
      persistence: this.persistence(),
    });
  }
  private publishConfig(): void {
    this.options.emit({
      type: "session.config",
      sessionId: this.options.id,
      config: {
        model: this.config.model,
        mode: this.config.mode,
        thinkingOption: this.config.thinkingOption,
        models: this.catalog.models,
        modes,
        thinkingOptions:
          this.catalog.models.find((model) => model.id === this.config.model)?.thinkingOptions ??
          efforts.map((id) => ({ id, label: id })),
        settings: [],
      },
    });
  }
}
function mcpServer(server: ProviderMcpServerConfig): SessionMcpServerConfig {
  if (server.type === "stdio")
    return {
      transport: "stdio",
      command: server.command,
      args: server.args,
      env: server.env,
      framing: "lineDelimitedJson",
    };
  return { transport: "streamableHttp", url: server.url, headers: server.headers };
}
