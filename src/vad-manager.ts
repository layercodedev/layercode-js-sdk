// @ts-ignore - VAD package does not provide TypeScript types
import { MicVAD } from '@ricky0123/vad-web';

export interface VADConfig {
  enabled?: boolean;
  gate_audio?: boolean;
  buffer_frames?: number;
  model?: string;
  positive_speech_threshold?: number;
  negative_speech_threshold?: number;
  redemption_frames?: number;
  min_speech_frames?: number;
  pre_speech_pad_frames?: number;
  frame_samples?: number;
}

export interface VADCallbacks {
  onSpeechStart: () => void;
  onSpeechEnd: () => void;
  onVADFailure: (error: any) => void;
  onStatusChange: (status: string) => void;
}

export class VADManager {
  private vad: MicVAD | null = null;
  private config: VADConfig | null = null;
  private callbacks: VADCallbacks;
  private isEnabled: boolean = true;
  private currentStream: MediaStream | null = null;

  constructor(callbacks: VADCallbacks) {
    this.callbacks = callbacks;
  }

  /**
   * Initializes VAD with the given configuration and audio stream
   */
  initialize(config: VADConfig | null, stream: MediaStream | null, pushToTalkEnabled: boolean): void {
    console.log('VAD Manager: Initializing with config:', config, 'stream:', !!stream, 'pushToTalkEnabled:', pushToTalkEnabled);

    this.config = config;
    this.currentStream = stream;
    this.isEnabled = !pushToTalkEnabled && config?.enabled !== false;

    if (!this.isEnabled) {
      console.log('VAD initialization skipped (push-to-talk mode or VAD disabled)');
      return;
    }

    if (!stream) {
      console.warn('No audio stream available for VAD initialization');
      return;
    }

    console.log('VAD Manager: Creating VAD instance with stream:', stream);
    this._createVADInstance();
  }

  /**
   * Creates a new VAD instance with the current configuration
   */
  private _createVADInstance(): void {
    if (!this.currentStream) {
      console.warn('No audio stream available for VAD creation');
      return;
    }

    // Log stream details for debugging
    const tracks = this.currentStream.getAudioTracks();
    if (tracks.length > 0) {
      const track = tracks[0];
      const settings = track.getSettings();
      console.log('VAD initializing with stream:', {
        deviceId: settings.deviceId,
        label: track.label,
        enabled: track.enabled,
        muted: track.muted,
      });
    } else {
      console.warn('VAD: No audio tracks found in stream');
    }

    // Build VAD configuration object
    const vadOptions: any = {
      stream: this.currentStream,
      onSpeechStart: () => {
        console.log('onSpeechStart: sending vad_start');
        this.callbacks.onSpeechStart();
      },
      onSpeechEnd: () => {
        console.log('onSpeechEnd: sending vad_end');
        this.callbacks.onSpeechEnd();
      },
    };

    // Apply VAD configuration from backend if available
    if (this.config) {
      if (this.config.model !== undefined) vadOptions.model = this.config.model;
      if (this.config.positive_speech_threshold !== undefined) vadOptions.positiveSpeechThreshold = this.config.positive_speech_threshold;
      if (this.config.negative_speech_threshold !== undefined) vadOptions.negativeSpeechThreshold = this.config.negative_speech_threshold;
      if (this.config.redemption_frames !== undefined) vadOptions.redemptionFrames = this.config.redemption_frames;
      if (this.config.min_speech_frames !== undefined) vadOptions.minSpeechFrames = this.config.min_speech_frames;
      if (this.config.pre_speech_pad_frames !== undefined) vadOptions.preSpeechPadFrames = this.config.pre_speech_pad_frames;
      if (this.config.frame_samples !== undefined) vadOptions.frameSamples = this.config.frame_samples;
    } else {
      // Default values if no config from backend
      vadOptions.model = 'v5';
      vadOptions.positiveSpeechThreshold = 0.15;
      vadOptions.negativeSpeechThreshold = 0.05;
      vadOptions.redemptionFrames = 4;
      vadOptions.minSpeechFrames = 2;
      vadOptions.preSpeechPadFrames = 0;
      vadOptions.frameSamples = 512; // Required for v5
    }

    console.log('Creating VAD with options:', vadOptions);

    MicVAD.new(vadOptions)
      .then((vad: MicVAD) => {
        this.vad = vad;
        this.vad.start();
        console.log('VAD started successfully');
      })
      .catch((error: any) => {
        console.error('Error initializing VAD:', error);
        this.callbacks.onVADFailure(error);
      });
  }

  /**
   * Reinitializes VAD with a new audio stream
   */
  reinitialize(stream: MediaStream | null): void {
    if (!this.isEnabled) {
      console.log('VAD reinitialization skipped (not enabled)');
      return;
    }

    console.log('Reinitializing VAD with new audio stream');

    // Clean up existing VAD instance
    this.destroy();

    // Update stream and recreate VAD
    this.currentStream = stream;
    this._createVADInstance();
  }

  /**
   * Forces VAD reinitialization with the current audio stream
   */
  forceReinitialization(): void {
    if (!this.isEnabled) {
      console.log('VAD reinitialization skipped (not enabled)');
      return;
    }

    console.log('Forcing VAD reinitialization');
    this.destroy();
    this._createVADInstance();
  }

  /**
   * Destroys the current VAD instance
   */
  destroy(): void {
    if (this.vad) {
      this.vad.pause();
      this.vad.destroy();
      this.vad = null;
    }
  }

  /**
   * Gets the current VAD instance
   */
  getInstance(): MicVAD | null {
    return this.vad;
  }

  /**
   * Checks if VAD is currently enabled
   */
  isVADEnabled(): boolean {
    return this.isEnabled;
  }

  /**
   * Gets the current VAD configuration
   */
  getConfig(): VADConfig | null {
    return this.config;
  }

  /**
   * Gets the current audio stream
   */
  getCurrentStream(): MediaStream | null {
    return this.currentStream;
  }
}
