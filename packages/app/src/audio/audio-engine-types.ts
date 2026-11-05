export interface AudioEngineCallbacks {
  onCaptureData(pcm: Uint8Array): void;
  onVolumeLevel(level: number): void;
  onInterruption?(): void;
  onCaptureAvailabilityChange?(available: boolean): void;
  onError?(error: Error): void;
}

export interface AudioPlaybackSource {
  arrayBuffer(): Promise<ArrayBuffer>;
  size: number;
  type: string;
  /** Ordered PCM chunks share one queue entry and one continuous playback clock. */
  stream?: (signal: AbortSignal) => AsyncIterable<AudioPlaybackStreamChunk>;
}

export interface AudioPlaybackStreamChunk {
  audio: AudioPlaybackSource;
  onPlayed(): void;
}

export interface AudioEngine {
  initialize(): Promise<void>;
  destroy(): Promise<void>;

  startCapture(): Promise<void>;
  stopCapture(): Promise<void>;
  toggleMute(): boolean;
  isMuted(): boolean;

  play(audio: AudioPlaybackSource, signal?: AbortSignal): Promise<number>;
  stop(): void;
  clearQueue(): void;
  isPlaying(): boolean;
}

export interface AudioEngineOptions {
  traceLabel?: string;
  captureMode?: "conversation" | "dictation";
}
