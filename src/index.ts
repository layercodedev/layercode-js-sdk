/* eslint-env browser */
// import { env as ortEnv } from 'onnxruntime-web';
// @ts-ignore - VAD package does not provide TypeScript types
import { MicVAD } from '@ricky0123/vad-web';
import { WavRecorder, WavStreamPlayer } from './wavtools/index.js';
import { base64ToArrayBuffer, arrayBufferToBase64 } from './utils.js';
import {
  ClientMessage,
  ServerMessage,
  ClientAudioMessage,
  ClientTriggerTurnMessage,
  ClientTriggerResponseAudioReplayFinishedMessage,
  ClientVadEventsMessage,
  ClientResponseTextMessage,
  ClientResponseDataMessage,
} from './interfaces.js';

export interface AgentConfig {
  transcription: {
    trigger: 'push_to_talk' | 'automatic';
    can_interrupt: boolean;
    automatic: boolean;
  };
  vad?: {
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
  };
}

interface AuthorizeSessionRequestParams {
  url: string;
  body: {
    agent_id: string;
    metadata: Record<string, any>;
    sdk_version: string;
    conversation_id?: string | null;
  };
}

type AuthorizeSessionRequest = (params: AuthorizeSessionRequestParams) => Promise<Response>;

const NOOP = () => {};
const DEFAULT_WS_URL = 'wss://api.layercode.com/v1/agents/web/websocket';

// SDK version - updated when publishing
const SDK_VERSION = '2.7.0';

export type LayercodeAudioInputDevice = (MediaDeviceInfo & { default: boolean }) & {
  label: string;
};

const MEDIA_DEVICE_CHANGE_EVENT = 'devicechange';
const MEDIA_DEVICE_KIND_AUDIO: MediaDeviceKind = 'audioinput';

const hasMediaDevicesSupport = (): boolean => typeof navigator !== 'undefined' && !!navigator.mediaDevices;

let microphonePermissionPromise: Promise<void> | null = null;
let microphonePermissionGranted = false;

const stopStreamTracks = (stream: MediaStream | null | undefined): void => {
  if (!stream) {
    return;
  }
  stream.getTracks().forEach((track) => {
    try {
      track.stop();
    } catch {
      /* noop */
    }
  });
};

const ensureMicrophonePermissions = async (): Promise<void> => {
  if (!hasMediaDevicesSupport()) {
    throw new Error('Media devices are not available in this environment');
  }

  if (microphonePermissionGranted) {
    return;
  }

  if (!microphonePermissionPromise) {
    microphonePermissionPromise = navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        microphonePermissionGranted = true;
        stopStreamTracks(stream);
      })
      .finally(() => {
        microphonePermissionPromise = null;
      });
  }

  return microphonePermissionPromise;
};

const cloneAudioDevice = (device: MediaDeviceInfo, isDefault: boolean): LayercodeAudioInputDevice => {
  const cloned: Partial<LayercodeAudioInputDevice> = {
    deviceId: device.deviceId,
    groupId: device.groupId,
    kind: device.kind,
    label: device.label,
    default: isDefault,
  };

  if (typeof device.toJSON === 'function') {
    cloned.toJSON = device.toJSON.bind(device);
  }

  return cloned as LayercodeAudioInputDevice;
};

const normalizeAudioInputDevices = (devices: MediaDeviceInfo[]): LayercodeAudioInputDevice[] => {
  const audioDevices = devices.filter((device) => device.kind === MEDIA_DEVICE_KIND_AUDIO);
  if (!audioDevices.length) {
    return [];
  }

  const remaining = [...audioDevices];
  const normalized: LayercodeAudioInputDevice[] = [];

  const defaultIndex = remaining.findIndex((device) => device.deviceId === 'default');
  if (defaultIndex !== -1) {
    let defaultDevice = remaining.splice(defaultIndex, 1)[0];
    const groupMatchIndex = remaining.findIndex((device) => device.groupId && defaultDevice.groupId && device.groupId === defaultDevice.groupId);
    if (groupMatchIndex !== -1) {
      defaultDevice = remaining.splice(groupMatchIndex, 1)[0];
    }
    normalized.push(cloneAudioDevice(defaultDevice, true));
  } else if (remaining.length) {
    const fallbackDefault = remaining.shift() as MediaDeviceInfo;
    normalized.push(cloneAudioDevice(fallbackDefault, true));
  }

  return normalized.concat(remaining.map((device) => cloneAudioDevice(device, false)));
};

export const listAudioInputDevices = async (): Promise<LayercodeAudioInputDevice[]> => {
  if (!hasMediaDevicesSupport()) {
    throw new Error('Media devices are not available in this environment');
  }

  await ensureMicrophonePermissions();
  const devices = await navigator.mediaDevices.enumerateDevices();
  return normalizeAudioInputDevices(devices);
};

export const watchAudioInputDevices = (callback: (devices: LayercodeAudioInputDevice[]) => void): (() => void) => {
  if (!hasMediaDevicesSupport()) {
    return () => {};
  }

  let disposed = false;
  let lastSignature: string | null = null;
  let requestId = 0;

  const emitDevices = async (): Promise<void> => {
    requestId += 1;
    const currentRequest = requestId;
    try {
      const devices = await listAudioInputDevices();
      if (disposed || currentRequest !== requestId) {
        return;
      }
      const signature = devices.map((device) => `${device.deviceId}:${device.label}:${device.groupId}:${device.default ? '1' : '0'}`).join('|');
      if (signature !== lastSignature) {
        lastSignature = signature;
        callback(devices);
      }
    } catch (error) {
      if (!disposed) {
        console.warn('Failed to refresh audio devices', error);
      }
    }
  };

  const handler = (): void => {
    void emitDevices();
  };

  const mediaDevices = navigator.mediaDevices;
  let teardown: (() => void) | null = null;
  if (typeof mediaDevices.addEventListener === 'function') {
    mediaDevices.addEventListener(MEDIA_DEVICE_CHANGE_EVENT, handler);
    teardown = () => mediaDevices.removeEventListener(MEDIA_DEVICE_CHANGE_EVENT, handler);
  } else if ('ondevicechange' in mediaDevices) {
    const previousHandler = mediaDevices.ondevicechange;
    mediaDevices.ondevicechange = handler;
    teardown = () => {
      if (mediaDevices.ondevicechange === handler) {
        mediaDevices.ondevicechange = previousHandler || null;
      }
    };
  }

  // Always emit once on subscribe
  void emitDevices();

  return () => {
    disposed = true;
    teardown?.();
  };
};

// const ORT_WARNING_MUTE_LEVEL: NonNullable<typeof ortEnv.logLevel> = 'error';
// try {
//   if (
//     typeof ortEnv !== 'undefined' &&
//     (!ortEnv.logLevel || ortEnv.logLevel === 'warning' || ortEnv.logLevel === 'info' || ortEnv.logLevel === 'verbose')
//   ) {
//     ortEnv.logLevel = ORT_WARNING_MUTE_LEVEL;
//   }
//   try {
//     const g: any = globalThis as any;
//     if (g?.ort?.env && (!g.ort.env.logLevel || g.ort.env.logLevel !== 'error')) {
//       g.ort.env.logLevel = ORT_WARNING_MUTE_LEVEL;
//     }
//   } catch {}
// } catch {
//   // Ignore failures when muting ONNX runtime logging; fallback to defaults
// }

// // Filter noisy ORT warnings emitted via nested bundled copies of onnxruntime-web.
// (() => {
//   try {
//     const ORT_WARN_RE = /\[W:onnxruntime:/;
//     const ORT_KNOWN_NOISE = [
//       'Removing initializer',
//     ];
//     const wrap = <T extends (...args: any[]) => any>(fn: T): T => {
//       const bound = fn.bind(console);
//       return ((...args: any[]) => {
//         try {
//           const first = args[0];
//           if (typeof first === 'string') {
//             if (ORT_WARN_RE.test(first) || ORT_KNOWN_NOISE.some((s) => first.includes(s))) {
//               return;
//             }
//           }
//         } catch {}
//         return bound(...args);
//       }) as T;
//     };
//     console.warn = wrap(console.warn);
//     console.log = wrap(console.log);
//   } catch {
//     // Non-fatal; leave console as-is
//   }
// })();

/**
 * Interface for LayercodeClient public methods
 */
interface ILayercodeClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  triggerUserTurnStarted(): Promise<void>;
  triggerUserTurnFinished(): Promise<void>;
  getStream(): MediaStream | null;
  setInputDevice(deviceId: string): Promise<void>;
  setPreferredInputDevice(deviceId: string | null): Promise<void>;
  setAudioInput(state: boolean): Promise<void>;
  setAudioOutput(state: boolean): Promise<void>;
  listDevices(): Promise<Array<MediaDeviceInfo & { default: boolean }>>;
  onDeviceSwitched?: (deviceId: string) => void;
  onDevicesChanged?: (devices: Array<MediaDeviceInfo & { default: boolean }>) => void;
  mute(): void;
  unmute(): void;
  sendClientResponseText(text: string): Promise<void>;
  sendClientResponseData(data: any): Promise<void>;
  readonly status: string;
  readonly userAudioAmplitude: number;
  readonly agentAudioAmplitude: number;
  readonly isMuted: boolean;
  readonly conversationId: string | null;
  readonly userSpeaking: boolean;
  readonly agentSpeaking: boolean;
}

/**
 * Interface for LayercodeClient constructor options
 */
interface LayercodeClientOptions {
  /** The ID of the Layercode agent to connect to */
  agentId: string;
  /** The ID of the conversation to connect to */
  conversationId?: string | null;
  /** The endpoint URL for the audio agent API */
  authorizeSessionEndpoint: string;
  /** Optional custom request handler for authorizing a session */
  authorizeSessionRequest?: AuthorizeSessionRequest;
  /** Metadata to send with webhooks */
  metadata?: Record<string, any>;
  /** Whether audio input is enabled. I.e. is the microphone turned on in the browser */
  audioInput?: boolean;
  /** Whether audio output is enabled. I.e. do we play the sound in the browser client */
  audioOutput?: boolean;
  /**
   * When true, defers actual audio hardware initialization (AudioContext, mic permissions)
   * until setAudioInput(true) or setAudioOutput(true) is called.
   * The server will still be told this is a voice session, but no browser audio APIs are touched until needed.
   * This avoids Chrome's autoplay policy blocking AudioContext before user gesture.
   */
  deferAudioInit?: boolean;
  /** Fired when audio input flag changes */
  audioInputChanged?: (audioInput: boolean) => void;
  /** Fired when audio output flag changes */
  audioOutputChanged?: (audioInput: boolean) => void;
  /** Milliseconds before resuming agent audio after temporary pause due to user interruption (which was actually a false interruption) */
  vadResumeDelay?: number;
  /** Callback when connection is established */
  onConnect?: ({ conversationId, config }: { conversationId: string | null; config?: AgentConfig }) => void;
  /** Callback when connection is closed */
  onDisconnect?: () => void;
  /** Callback when an error occurs */
  onError?: (error: Error) => void;
  /** Callback when a device is switched */
  onDeviceSwitched?: (deviceId: string) => void;
  /** Callback when available devices change (devices added/removed) */
  onDevicesChanged?: (devices: Array<MediaDeviceInfo & { default: boolean }>) => void;
  /** Callback for data messages */
  onDataMessage?: (message: any) => void;
  /** Callback for other messages (excluding audio msgs) */
  onMessage?: (message: any) => void;
  /** Callback for user audio amplitude changes */
  onUserAmplitudeChange?: (amplitude: number) => void;
  /** Callback for agent audio amplitude changes */
  onAgentAmplitudeChange?: (amplitude: number) => void;
  /** Callback when connection status changes */
  onStatusChange?: (status: string) => void;
  /** Callback when user turn changes */
  onUserIsSpeakingChange?: (isSpeaking: boolean) => void;
  /** Callback when agent speaking state changes */
  onAgentSpeakingChange?: (isSpeaking: boolean) => void;
  /** Callback when mute state changes */
  onMuteStateChange?: (isMuted: boolean) => void;
  /** Whether amplitude monitoring should run for mic and speaker */
  enableAmplitudeMonitoring?: boolean;
}

type NormalizedLayercodeClientOptions = Required<Omit<LayercodeClientOptions, 'authorizeSessionRequest' | 'deferAudioInit'>> & Pick<LayercodeClientOptions, 'authorizeSessionRequest' | 'deferAudioInit'>;

/**
 * @class LayercodeClient
 * @classdesc Core client for Layercode audio agent that manages audio recording, WebSocket communication, and speech processing.
 */
class LayercodeClient implements ILayercodeClient {
  private options: NormalizedLayercodeClientOptions;
  private wavRecorder: WavRecorder;
  private wavPlayer: WavStreamPlayer;
  private vad: MicVAD | null;
  private ws: WebSocket | null;
  private audioInput: boolean;
  private audioOutput: boolean;
  private AMPLITUDE_MONITORING_SAMPLE_RATE: number;
  private audioOutputReady: Promise<void> | null;
  private pushToTalkActive: boolean;
  private pushToTalkEnabled: boolean;
  private canInterrupt: boolean;
  private userIsSpeaking: boolean;
  private agentIsSpeaking: boolean;
  private agentIsPlayingAudio: boolean; // Tracks actual audio playback state, independent of audioOutput
  private recorderStarted: boolean; // Indicates that WavRecorder.record() has been called successfully
  private readySent: boolean; // Ensures we send client.ready only once
  private currentTurnId: string | null; // Track current turn ID
  private sentReplayFinishedForDisabledOutput: boolean; // Track if we've sent replay_finished when audioOutput is disabled
  private audioBuffer: string[]; // Buffer to catch audio just before VAD triggers
  private vadConfig: AgentConfig['vad'] | null;
  private deviceId: string | null = null;
  private activeDeviceId: string | null;
  private useSystemDefaultDevice: boolean;
  private lastReportedDeviceId: string | null;
  private lastKnownSystemDefaultDeviceKey: string | null;
  private stopPlayerAmplitude?: () => void;
  private stopRecorderAmplitude?: () => void;
  private deviceChangeListener: ((devices: any[]) => Promise<void>) | null;
  // private audioPauseTime: number | null; // Track when audio was paused for VAD
  private recorderRestartChain: Promise<void>;
  private deviceListenerReady: Promise<void> | null;
  private resolveDeviceListenerReady: (() => void) | null;
  _websocketUrl: string;
  status: string;
  userAudioAmplitude: number;
  agentAudioAmplitude: number;
  isMuted: boolean; // Track mute state
  conversationId: string | null;
  /**
   * Creates an instance of LayercodeClient.
   * @param {Object} options - Configuration options
   */
  constructor(options: LayercodeClientOptions) {
    this.options = {
      agentId: options.agentId,
      conversationId: options.conversationId ?? null,
      authorizeSessionEndpoint: options.authorizeSessionEndpoint,
      authorizeSessionRequest: options.authorizeSessionRequest,
      metadata: options.metadata ?? {},
      vadResumeDelay: options.vadResumeDelay ?? 500,
      audioInput: options.audioInput ?? true,
      audioInputChanged: options.audioInputChanged ?? NOOP,
      audioOutput: options.audioOutput ?? true,
      audioOutputChanged: options.audioOutputChanged ?? NOOP,
      onConnect: options.onConnect ?? NOOP,
      onDisconnect: options.onDisconnect ?? NOOP,
      onError: options.onError ?? NOOP,
      onDeviceSwitched: options.onDeviceSwitched ?? NOOP,
      onDevicesChanged: options.onDevicesChanged ?? NOOP,
      onDataMessage: options.onDataMessage ?? NOOP,
      onMessage: options.onMessage ?? NOOP,
      onUserAmplitudeChange: options.onUserAmplitudeChange ?? NOOP,
      onAgentAmplitudeChange: options.onAgentAmplitudeChange ?? NOOP,
      onStatusChange: options.onStatusChange ?? NOOP,
      onUserIsSpeakingChange: options.onUserIsSpeakingChange ?? NOOP,
      onAgentSpeakingChange: options.onAgentSpeakingChange ?? NOOP,
      onMuteStateChange: options.onMuteStateChange ?? NOOP,
      enableAmplitudeMonitoring: options.enableAmplitudeMonitoring ?? true,
    };

    this.audioInput = options.audioInput ?? true;
    this.audioOutput = options.audioOutput ?? true;

    this._emitAudioInput();

    this.AMPLITUDE_MONITORING_SAMPLE_RATE = 2;
    this._websocketUrl = DEFAULT_WS_URL;
    this.audioOutputReady = null;

    this.wavRecorder = new WavRecorder({ sampleRate: 8000 }); // TODO should be set my fetched agent config
    this.wavPlayer = new WavStreamPlayer({
      finishedPlayingCallback: this._clientResponseAudioReplayFinished.bind(this),
      sampleRate: 16000, // TODO should be set my fetched agent config
    });
    this.vad = null;
    this.ws = null;
    this.status = 'disconnected';
    this.userAudioAmplitude = 0;
    this.agentAudioAmplitude = 0;
    this.conversationId = this.options.conversationId;
    this.pushToTalkActive = false;
    this.pushToTalkEnabled = false;
    this.canInterrupt = false;
    this.userIsSpeaking = false;
    this.agentIsSpeaking = false;
    this.agentIsPlayingAudio = false;
    this.recorderStarted = false;
    this.readySent = false;
    this.currentTurnId = null;
    this.sentReplayFinishedForDisabledOutput = false;
    this.audioBuffer = [];
    this.vadConfig = null;
    this.activeDeviceId = null;
    this.useSystemDefaultDevice = false;
    this.lastReportedDeviceId = null;
    this.lastKnownSystemDefaultDeviceKey = null;
    this.isMuted = false;
    this.stopPlayerAmplitude = undefined;
    this.stopRecorderAmplitude = undefined;
    this.deviceChangeListener = null;
    this.recorderRestartChain = Promise.resolve();
    this.deviceListenerReady = null;
    this.resolveDeviceListenerReady = null;
    // this.audioPauseTime = null;

    // Bind event handlers
    this._handleWebSocketMessage = this._handleWebSocketMessage.bind(this);
    this._handleDataAvailable = this._handleDataAvailable.bind(this);
  }

  get onDeviceSwitched(): (deviceId: string) => void {
    return this.options.onDeviceSwitched;
  }

  set onDeviceSwitched(callback: LayercodeClientOptions['onDeviceSwitched']) {
    this.options.onDeviceSwitched = callback ?? NOOP;
  }

  get onDevicesChanged(): (devices: Array<MediaDeviceInfo & { default: boolean }>) => void {
    return this.options.onDevicesChanged;
  }

  set onDevicesChanged(callback: LayercodeClientOptions['onDevicesChanged']) {
    this.options.onDevicesChanged = callback ?? NOOP;
  }

  private _initializeVAD(): void {
    console.log('initializing VAD', { pushToTalkEnabled: this.pushToTalkEnabled, canInterrupt: this.canInterrupt, vadConfig: this.vadConfig });

    // If we're in push to talk mode or mute mode, we don't need to use the VAD model
    if (this.pushToTalkEnabled || !this._shouldCaptureUserAudio()) {
      console.debug('Skipping VAD init: audio input disabled or muted');
      return;
    }

    // Check if VAD is disabled
    if (this.vadConfig?.enabled === false) {
      console.log('VAD is disabled by backend configuration');
      return;
    }

    if (!this._hasLiveRecorderStream()) {
      console.debug('Skipping VAD init: recorder stream is not available');
      return;
    }

    const recorderStream = this.wavRecorder.getStream();
    if (!recorderStream) {
      console.debug('Skipping VAD init: no recorder stream reference');
      return;
    }

    // Build VAD configuration object, only including keys that are defined
    const vadOptions: any = {
      stream: recorderStream,
      onnxWASMBasePath: 'https://assets.layercode.com/onnxruntime-web/1.23.2/',
      baseAssetPath: 'https://assets.layercode.com/vad-web/0.0.29/',
      onSpeechStart: () => {
        console.debug('onSpeechStart: sending vad_start');
        this._setUserSpeaking(true);
        const vadStartMessage: ClientVadEventsMessage = {
          type: 'vad_events',
          event: 'vad_start',
        };
        this._wsSend(vadStartMessage);
        this.options.onMessage({
          ...vadStartMessage,
          userSpeaking: this.userIsSpeaking,
        });
      },
      onSpeechEnd: () => {
        console.debug('onSpeechEnd: sending vad_end');
        this._setUserSpeaking(false);
        this.audioBuffer = []; // Clear buffer on speech end
        const vadEndMessage: ClientVadEventsMessage = {
          type: 'vad_events',
          event: 'vad_end',
        };
        this._wsSend(vadEndMessage);
        this.options.onMessage({
          ...vadEndMessage,
          userSpeaking: this.userIsSpeaking,
        });
      },
    };

    // Apply VAD configuration from backend if available
    if (this.vadConfig) {
      // Only add keys that are explicitly defined (not undefined)
      if (this.vadConfig.model !== undefined) vadOptions.model = this.vadConfig.model;
      if (this.vadConfig.positive_speech_threshold !== undefined) vadOptions.positiveSpeechThreshold = this.vadConfig.positive_speech_threshold;
      if (this.vadConfig.negative_speech_threshold !== undefined) vadOptions.negativeSpeechThreshold = this.vadConfig.negative_speech_threshold;
      if (this.vadConfig.redemption_frames !== undefined) vadOptions.redemptionFrames = this.vadConfig.redemption_frames;
      if (this.vadConfig.min_speech_frames !== undefined) vadOptions.minSpeechFrames = this.vadConfig.min_speech_frames;
      if (this.vadConfig.pre_speech_pad_frames !== undefined) vadOptions.preSpeechPadFrames = this.vadConfig.pre_speech_pad_frames;
      if (this.vadConfig.frame_samples !== undefined) vadOptions.frameSamples = this.vadConfig.frame_samples;
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
        console.warn('Error initializing VAD:', error);
        // Send a message to server indicating VAD failure
        const vadFailureMessage: ClientVadEventsMessage = {
          type: 'vad_events',
          event: 'vad_model_failed',
        };
        this._wsSend(vadFailureMessage);
        this.options.onMessage({
          ...vadFailureMessage,
          userSpeaking: this.userIsSpeaking,
        });
      });
  }

  /**
   * Updates the connection status and triggers the callback
   * @param {string} status - New status value
   */
  private _setStatus(status: string): void {
    this.status = status;
    this.options.onStatusChange(status);
  }

  private async _waitForAudioOutputReady(): Promise<void> {
    if (!this.audioOutputReady) {
      return;
    }
    await this.audioOutputReady;
  }

  private _setAgentSpeaking(isSpeaking: boolean): void {
    // Track the actual audio playback state regardless of audioOutput setting
    this.agentIsPlayingAudio = isSpeaking;

    const shouldReportSpeaking = this.audioOutput && isSpeaking;
    if (this.agentIsSpeaking === shouldReportSpeaking) {
      return;
    }
    this.agentIsSpeaking = shouldReportSpeaking;
    this.options.onAgentSpeakingChange(shouldReportSpeaking);
  }

  private _setUserSpeaking(isSpeaking: boolean): void {
    const shouldCapture = this._shouldCaptureUserAudio();
    const shouldReportSpeaking = shouldCapture && isSpeaking;
    console.log('_setUserSpeaking called:', isSpeaking, 'shouldCapture:', shouldCapture, 'shouldReportSpeaking:', shouldReportSpeaking, 'current userIsSpeaking:', this.userIsSpeaking);
    if (this.userIsSpeaking === shouldReportSpeaking) {
      return;
    }
    this.userIsSpeaking = shouldReportSpeaking;
    console.log('_setUserSpeaking: updated userIsSpeaking to:', this.userIsSpeaking);
    this.options.onUserIsSpeakingChange(shouldReportSpeaking);
  }

  /**
   * Handles when agent audio finishes playing
   */
  private _clientResponseAudioReplayFinished(): void {
    console.debug('clientResponseAudioReplayFinished');
    this._setAgentSpeaking(false);
    const replayFinishedMessage: ClientTriggerResponseAudioReplayFinishedMessage = {
      type: 'trigger.response.audio.replay_finished',
      reason: 'completed',
    };
    this.options.onMessage({
      ...replayFinishedMessage,
      agentSpeaking: this.agentIsSpeaking,
    });
    this._wsSend(replayFinishedMessage);
  }

  private async _clientInterruptAgentReplay(): Promise<void> {
    await this.wavPlayer.interrupt();
    this._setAgentSpeaking(false);
  }

  async triggerUserTurnStarted(): Promise<void> {
    if (!this.pushToTalkActive) {
      this.pushToTalkActive = true;
      this._setUserSpeaking(true);
      this._wsSend({ type: 'trigger.turn.start', role: 'user' } as ClientTriggerTurnMessage);
      await this._clientInterruptAgentReplay();
    }
  }

  async triggerUserTurnFinished(): Promise<void> {
    if (this.pushToTalkActive) {
      this.pushToTalkActive = false;
      this._setUserSpeaking(false);
      this._wsSend({ type: 'trigger.turn.end', role: 'user' } as ClientTriggerTurnMessage);
    }
  }

  async sendClientResponseText(text: string): Promise<void> {
    await this._clientInterruptAgentReplay();
    this._wsSend({ type: 'client.response.text', content: text } as ClientResponseTextMessage);
  }

  async sendClientResponseData(data: any): Promise<void> {
    this._wsSend({ type: 'client.response.data', data: data } as ClientResponseDataMessage);
  }

  /**
   * Handles incoming WebSocket messages
   * @param {MessageEvent} event - The WebSocket message event
   */
  private async _handleWebSocketMessage(event: MessageEvent): Promise<void> {
    try {
      const message: ServerMessage = JSON.parse(event.data);
      if (message.type !== 'response.audio') {
        console.debug('msg:', message);
      }

      switch (message.type) {
        case 'turn.start': {
          // Sent from the server to this client when a new turn is detected
          if (message.role === 'assistant') {
            // Start tracking new agent turn
            console.debug('Agent turn started, will track new turn ID from audio/text');
            this._setUserSpeaking(false);
            // Reset the flag for the new assistant turn
            this.sentReplayFinishedForDisabledOutput = false;

            // When assistant's turn starts but we're not playing audio,
            // we need to tell the server we're "done" with playback so it can
            // transition the turn back to user. Use a small delay to let any
            // response.audio/response.end messages arrive first.
            if (!this.audioOutput) {
              setTimeout(() => {
                if (!this.audioOutput && !this.sentReplayFinishedForDisabledOutput) {
                  this.sentReplayFinishedForDisabledOutput = true;
                  this._clientResponseAudioReplayFinished();
                }
              }, 1000);
            }
          } else if (message.role === 'user' && !this.pushToTalkEnabled) {
            // Interrupt any playing agent audio if this is a turn triggered by the server (and not push to talk, which will have already called interrupt)
            console.debug('interrupting agent audio, as user turn has started and pushToTalkEnabled is false');
            await this._clientInterruptAgentReplay();
            this._setAgentSpeaking(false);
            this._setUserSpeaking(true);
          } else if (message.role === 'user') {
            this._setAgentSpeaking(false);
            this._setUserSpeaking(true);
          }
          this.options.onMessage({
            ...message,
            agentSpeaking: this.agentIsSpeaking,
            userSpeaking: this.userIsSpeaking,
          });
          break;
        }

        case 'response.end': {
          // When audioOutput is disabled, notify server that "playback" is complete
          if (!this.audioOutput && !this.sentReplayFinishedForDisabledOutput) {
            this.sentReplayFinishedForDisabledOutput = true;
            this._clientResponseAudioReplayFinished();
          }
          this.options.onMessage?.(message);
          break;
        }

        case 'response.audio': {
          // Skip audio playback if audioOutput is disabled
          if (!this.audioOutput) {
            // Send replay_finished so server knows we're "done" with playback (only once per turn)
            if (!this.sentReplayFinishedForDisabledOutput) {
              this.sentReplayFinishedForDisabledOutput = true;
              this._clientResponseAudioReplayFinished();
            }
            break;
          }

          await this._waitForAudioOutputReady();

          const audioBuffer = base64ToArrayBuffer(message.content);
          const hasAudioSamples = audioBuffer.byteLength > 0;
          let audioEnqueued = false;

          if (hasAudioSamples) {
            try {
              const playbackBuffer = this.wavPlayer.add16BitPCM(audioBuffer, message.turn_id);
              audioEnqueued = Boolean(playbackBuffer && playbackBuffer.length > 0);
            } catch (error) {
              this._setAgentSpeaking(false);
              throw error;
            }
          } else {
            console.debug(`Skipping empty audio response for turn ${message.turn_id}`);
          }

          // TODO: once we've added turn_id to the turn.start msgs sent from teh server, we should move this currentTurnId switching logic to the turn.start msg case. We can then remove the currentTurnId setting logic from the response.audio and response.text cases.
          // Set current turn ID from first audio message, or update if different turn
          if (!this.currentTurnId || this.currentTurnId !== message.turn_id) {
            console.debug(`Setting current turn ID to: ${message.turn_id} (was: ${this.currentTurnId})`);
            this.currentTurnId = message.turn_id;

            // Clean up interrupted tracks, keeping only the current turn
            this.wavPlayer.clearInterruptedTracks(this.currentTurnId ? [this.currentTurnId] : []);
          }

          if (audioEnqueued) {
            this._setAgentSpeaking(true);
          }
          break;
        }

        case 'response.text':
          // Set turn ID from first text message if not set
          if (!this.currentTurnId) {
            this.currentTurnId = message.turn_id;
            console.debug(`Setting current turn ID to: ${message.turn_id} from text message`);
          }
          this.options.onMessage({
            ...message,
            agentSpeaking: this.agentIsSpeaking,
          });
          break;

        case 'response.data':
          this.options.onDataMessage({
            ...message,
            agentSpeaking: this.agentIsSpeaking,
          });
          break;

        case 'user.transcript':
        case 'user.transcript.delta':
        case 'user.transcript.interim_delta':
          this.options.onMessage({
            ...message,
            userSpeaking: this.userIsSpeaking,
          });
          break;

        default:
          console.warn('Unknown message type received:', message);
      }
    } catch (error) {
      console.error('Error processing WebSocket message:', error);
      this.options.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Handles available client browser microphone audio data and sends it over the WebSocket
   * @param {ArrayBuffer} data - The audio data buffer
   */
  private _handleDataAvailable(data: { mono: Int16Array<ArrayBufferLike> }): void {
    try {

      const base64 = arrayBufferToBase64(data.mono);

      // Don't send audio if muted
      if (this.isMuted) {
        return;
      }

      // Determine if we should gate audio based on VAD configuration
      const shouldGateAudio = this.vadConfig?.gate_audio !== false; // Default to true if not specified
      const bufferFrames = this.vadConfig?.buffer_frames ?? 10; // Default to 10 if not specified

      let sendAudio: boolean;
      if (this.pushToTalkEnabled) {
        sendAudio = this.pushToTalkActive;
      } else if (shouldGateAudio) {
        sendAudio = this.userIsSpeaking;
      } else {
        // If gate_audio is false, always send audio
        sendAudio = true;
      }

      if (sendAudio) {
        // If we have buffered audio and we're gating, send it first
        if (shouldGateAudio && this.audioBuffer.length > 0) {
          console.debug(`Sending ${this.audioBuffer.length} buffered audio chunks`);
          for (const bufferedAudio of this.audioBuffer) {
            this._wsSend({
              type: 'client.audio',
              content: bufferedAudio,
            } as ClientAudioMessage);
          }
          this.audioBuffer = []; // Clear the buffer after sending
        }

        // Send the current audio
        this._wsSend({
          type: 'client.audio',
          content: base64,
        } as ClientAudioMessage);
      } else {
        // Buffer audio when not sending (to catch audio just before VAD triggers)
        this.audioBuffer.push(base64);

        // Keep buffer size based on configuration
        if (this.audioBuffer.length > bufferFrames) {
          this.audioBuffer.shift(); // Remove oldest chunk
        }
      }
    } catch (error) {
      console.error('Error processing audio:', error);
      this.options.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private _wsSend(message: ClientMessage): void {
    if (message.type !== 'client.audio') {
      console.debug('sent_msg:', message);
    }
    const messageString = JSON.stringify(message);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(messageString);
    } else {
      // console.error('WebSocket is not open. Did not send message:', messageString);
    }
  }

  private _sendReadyIfNeeded(): void {
    // Send client.ready when either:
    // 1. Recorder is started (audio mode active)
    // 2. audioInput is false (text-only mode, but server should still be ready)
    const audioReady = this.recorderStarted || !this.audioInput;
    if (audioReady && this.ws?.readyState === WebSocket.OPEN && !this.readySent) {
      this._wsSend({ type: 'client.ready' } as ClientMessage);
      this.readySent = true;
    }
  }


  /**
   * Sets up amplitude monitoring for a given audio source.
   * @param {WavRecorder | WavStreamPlayer} source - The audio source (recorder or player).
   * @param {(amplitude: number) => void} callback - The callback function to invoke on amplitude change.
   * @param {(amplitude: number) => void} updateInternalState - Function to update the internal amplitude state.
   */
  private _setupAmplitudeMonitoring(source: WavRecorder | WavStreamPlayer, callback: (amplitude: number) => void, updateInternalState: (amplitude: number) => void): void {
    let updateCounter = 0;

    if (this.options.enableAmplitudeMonitoring) {
      source.startAmplitudeMonitoring((amplitude: number) => {
        if (updateCounter >= this.AMPLITUDE_MONITORING_SAMPLE_RATE) {
          updateInternalState(amplitude);
          if (callback !== NOOP) {
            callback(amplitude);
          }
          updateCounter = 0;
        }
        updateCounter++;
      });
    } else {
      updateInternalState(0);
    }

    const stop = () => source.stopAmplitudeMonitoring?.();
    if (source === this.wavPlayer) {
      this.stopPlayerAmplitude = stop;
    }
    if (source === this.wavRecorder) {
      this.stopRecorderAmplitude = stop;
    }
  }

  private _stopAmplitudeMonitoring(): void {
    this._stopPlayerAmplitudeMonitoring();
    this._stopRecorderAmplitudeMonitoring();
  }

  private _stopPlayerAmplitudeMonitoring(): void {
    this.agentAudioAmplitude = 0;
    if (this.options.enableAmplitudeMonitoring && this.options.onAgentAmplitudeChange !== NOOP) {
      this.options.onAgentAmplitudeChange(0);
    }
    if (this.stopPlayerAmplitude) {
      this.stopPlayerAmplitude?.();
      this.stopPlayerAmplitude = undefined;
    }
  }
  private _stopRecorderAmplitudeMonitoring(): void {
    this.userAudioAmplitude = 0;
    if (this.options.enableAmplitudeMonitoring && this.options.onUserAmplitudeChange !== NOOP) {
      this.options.onUserAmplitudeChange(0);
    }
    if (this.stopRecorderAmplitude) {
      this.stopRecorderAmplitude?.();
      this.stopRecorderAmplitude = undefined;
    }
  }

  async audioInputConnect(): Promise<void> {
    // Turn mic ON
    console.log('audioInputConnect: requesting permission');
    await this.wavRecorder.requestPermission();
    console.log('audioInputConnect: setting up device change listener');
    await this._setupDeviceChangeListener();

    // If the recorder hasn't spun up yet, proactively select a device.
    if (!this.recorderStarted && this.deviceChangeListener) {
      console.log('audioInputConnect: initializing recorder with default device');
      await this._initializeRecorderWithDefaultDevice();
    }
    console.log('audioInputConnect: done, recorderStarted =', this.recorderStarted);
  }

  async audioInputDisconnect(): Promise<void> {
    try {
      // stop amplitude monitoring tied to the recorder
      this._stopRecorderAmplitudeMonitoring();
      // Try a graceful stop; end() already stops tracks and closes the AudioContext
      await this.wavRecorder.end();
      this.stopVad();
      // Remove device listeners and reset flags
      this._teardownDeviceListeners();
      this.recorderStarted = false;
    } catch {
      // If there wasn't an active session, just release any stray tracks
      const stream = this.wavRecorder.getStream();
      stream?.getTracks().forEach((t) => t.stop());
    }
  }

  async setAudioInput(state: boolean): Promise<void> {
    if (this.audioInput !== state) {
      this.audioInput = state;
      this._emitAudioInput();

      if (state) {
        await this.audioInputConnect();
      } else {
        await this.audioInputDisconnect();
      }
    }
  }
  async setAudioOutput(state: boolean): Promise<void> {
    console.log('setAudioOutput called with state:', state, 'current:', this.audioOutput);
    if (this.audioOutput !== state) {
      this.audioOutput = state;
      this._emitAudioOutput();
      if (state) {
        // Initialize audio output if not already connected
        // This happens when audioOutput was initially false and is now being enabled
        if (!this.wavPlayer.context) {
          console.log('setAudioOutput: initializing audio output (no context yet)');
          await this.setupAudioOutput();
        } else {
          console.log('setAudioOutput: unmuting existing player');
          this.wavPlayer.unmute();
        }
        // Sync agentSpeaking state with actual playback state when enabling audio output
        this._syncAgentSpeakingState();
      } else {
        this.wavPlayer.mute();
        this._setAgentSpeaking(false);
      }
    }
  }

  /**
   * Syncs the reported agentSpeaking state with the actual audio playback state.
   * Called when audioOutput is enabled to ensure proper state synchronization.
   */
  private _syncAgentSpeakingState(): void {
    const shouldReportSpeaking = this.audioOutput && this.agentIsPlayingAudio;
    if (this.agentIsSpeaking !== shouldReportSpeaking) {
      this.agentIsSpeaking = shouldReportSpeaking;
      this.options.onAgentSpeakingChange(shouldReportSpeaking);
    }
  }

  /** Emitters for audio flags */
  private _emitAudioInput(): void {
    this.options.audioInputChanged(this.audioInput);
  }

  private _emitAudioOutput(): void {
    this.options.audioOutputChanged(this.audioOutput);
  }

  private _shouldCaptureUserAudio(): boolean {
    return this.audioInput && !this.isMuted;
  }

  private _hasLiveRecorderStream(): boolean {
    const stream = this.wavRecorder.getStream();
    if (!stream) {
      return false;
    }
    const tracks = typeof stream.getAudioTracks === 'function' ? stream.getAudioTracks() : [];
    return tracks.some((track) => track.readyState === 'live');
  }

  get audioInputEnabled(): boolean {
    return this.audioInput;
  }

  get userSpeaking(): boolean {
    return this.userIsSpeaking;
  }

  get agentSpeaking(): boolean {
    return this.agentIsSpeaking;
  }

  /**
   * Connects to the Layercode agent using the stored conversation ID and starts the audio conversation
   * @async
   * @returns {Promise<void>}
   */
  async connect(): Promise<void> {
    if (this.status === 'connecting') {
      return;
    }

    try {
      this._setStatus('connecting');

      // Reset turn tracking for clean start
      this._resetTurnTracking();
      this._stopAmplitudeMonitoring();

      // Get conversation key from server
      const authorizeSessionResponseBody = await this.authorizeSession();

      await this.connectToAudioInput();

      // Connect WebSocket
      const ws = new WebSocket(
        `${this._websocketUrl}?${new URLSearchParams({
          client_session_key: authorizeSessionResponseBody.client_session_key,
        })}`
      );
      this.ws = ws;
      const config: AgentConfig = authorizeSessionResponseBody.config;
      console.log('AgentConfig', config);

      // Store VAD configuration
      this.setupVadConfig(config);

      // Bind the websocket message callbacks
      this.bindWebsocketMessageCallbacks(ws, config);

      const audioOutputReady = this.setupAudioOutput();
      this.audioOutputReady = audioOutputReady;
      await audioOutputReady;
    } catch (error) {
      console.error('Error connecting to Layercode agent:', error);
      this._setStatus('error');
      this.options.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private bindWebsocketMessageCallbacks(ws: WebSocket, config: AgentConfig) {
    ws.onmessage = this._handleWebSocketMessage;
    ws.onopen = () => {
      console.log('WebSocket connection established');
      this._setStatus('connected');
      this.options.onConnect({ conversationId: this.conversationId, config });

      // Attempt to send ready message if recorder already started
      this._sendReadyIfNeeded();
    };
    ws.onclose = () => {
      console.log('WebSocket connection closed');
      this.ws = null;
      this._performDisconnectCleanup().catch((error) => {
        console.error('Error during disconnect cleanup:', error);
        this.options.onError(error instanceof Error ? error : new Error(String(error)));
      });
    };
    ws.onerror = (error: Event) => {
      console.error('WebSocket error:', error);
      this._setStatus('error');
      this.options.onError(new Error('WebSocket connection error'));
    };
  }

  private setupVadConfig(config: AgentConfig) {
    this.vadConfig = config.vad || null;

    if (config.transcription.trigger === 'push_to_talk') {
      this.pushToTalkEnabled = true;
    } else if (config.transcription.trigger === 'automatic') {
      this.pushToTalkEnabled = false;
      this.canInterrupt = config.transcription.can_interrupt;
    } else {
      throw new Error(`Unknown trigger: ${config.transcription.trigger}`);
    }
  }

  private async authorizeSession() {
    const authorizeSessionRequestBody = {
      agent_id: this.options.agentId,
      metadata: this.options.metadata,
      sdk_version: SDK_VERSION,
    } as { agent_id: string; metadata: Record<string, any>; sdk_version: string; conversation_id?: string };
    // If we're reconnecting to a previous conversation, we need to include the conversation_id in the request. Otherwise we don't send conversation_id, and a new conversation will be created and the conversation_id will be returned in the response.
    if (this.options.conversationId) {
      authorizeSessionRequestBody.conversation_id = this.options.conversationId;
    }
    const defaultRequestInit: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(authorizeSessionRequestBody),
    };
    const authorizeSessionResponse = this.options.authorizeSessionRequest
      ? await this.options.authorizeSessionRequest({
          url: this.options.authorizeSessionEndpoint,
          body: authorizeSessionRequestBody,
        })
      : await fetch(this.options.authorizeSessionEndpoint, defaultRequestInit);
    if (!authorizeSessionResponse) {
      throw new Error('authorizeSessionRequest did not return a response');
    }
    if (!authorizeSessionResponse.ok) {
      throw new Error(`Failed to authorize conversation: ${authorizeSessionResponse.statusText}`);
    }
    const authorizeSessionResponseBody = await authorizeSessionResponse.json();
    this.conversationId = authorizeSessionResponseBody.conversation_id; // Save the conversation_id for use in future reconnects

    this.options.conversationId = this.conversationId;
    return authorizeSessionResponseBody;
  }

  private async setupAudioOutput() {
    // Only initialize audio player if audioOutput is enabled
    // This prevents AudioContext creation before user gesture when audio is disabled
    if (!this.audioOutput) {
      return;
    }

    // Initialize audio player
    // wavRecorder will be started from the onDeviceSwitched callback,
    // which is called when the device is first initialized and also when the device is switched
    // this is to ensure that the device is initialized before the recorder is started
    await this.wavPlayer.connect();
    // Set up audio player amplitude monitoring
    this._setupAmplitudeMonitoring(this.wavPlayer, this.options.onAgentAmplitudeChange, (amp) => (this.agentAudioAmplitude = amp));
    if (!this.options.enableAmplitudeMonitoring) {
      this.agentAudioAmplitude = 0;
    }
    this.wavPlayer.unmute();
  }

  private async connectToAudioInput() {
    if (!this.audioInput) {
      await this.audioInputDisconnect();
      return;
    }

    await this.audioInputConnect();
  }

  private _resetTurnTracking(): void {
    this.currentTurnId = null;
    this._setAgentSpeaking(false);
    this._setUserSpeaking(false);
    console.debug('Reset turn tracking state');
  }

  async disconnect(): Promise<void> {
    if (this.status === 'disconnected') {
      return;
    }

    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.close();
      this.ws = null;
    }

    await this._performDisconnectCleanup();
  }

  /**
   * Gets the microphone MediaStream used by this client
   * @returns {MediaStream|null} The microphone stream or null if not initialized
   */
  getStream(): MediaStream | null {
    return this.wavRecorder.getStream();
  }

  /**
   * List all available audio input devices
   * @returns {Promise<Array<MediaDeviceInfo & {default: boolean}>>}
   */
  async listDevices(): Promise<Array<MediaDeviceInfo & { default: boolean }>> {
    return this.wavRecorder.listDevices();
  }

  /**
   * Switches the input device for the microphone and restarts recording
   * @param {string} deviceId - The deviceId of the new microphone
   */
  async setInputDevice(deviceId: string): Promise<void> {
    console.log('setInputDevice called with:', deviceId, 'audioInput:', this.audioInput);
    const normalizedDeviceId = !deviceId || deviceId === 'default' ? null : deviceId;
    this.useSystemDefaultDevice = normalizedDeviceId === null;
    this.deviceId = normalizedDeviceId;

    if (!this.audioInput) {
      console.debug('Audio input disabled; storing preferred device without restarting recorder');
      return;
    }

    try {
      console.log('setInputDevice: calling _queueRecorderRestart');
      // Restart recording with the new device
      await this._queueRecorderRestart();

      // Reinitialize VAD with the new audio stream if VAD is enabled
      const shouldUseVAD = !this.pushToTalkEnabled && this.vadConfig?.enabled !== false;
      if (shouldUseVAD) {
        console.debug('Reinitializing VAD with new audio stream');
        const newStream = this.wavRecorder.getStream();
        await this._reinitializeVAD(newStream);
      }
      const reportedDeviceId = this.lastReportedDeviceId ?? this.activeDeviceId ?? (this.useSystemDefaultDevice ? 'default' : normalizedDeviceId ?? 'default');
      console.debug(`Successfully switched to input device: ${reportedDeviceId}`);
    } catch (error) {
      console.error(`Failed to switch to input device ${deviceId}:`, error);
      throw new Error(`Failed to switch to input device: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async setPreferredInputDevice(deviceId: string | null): Promise<void> {
    const normalizedDeviceId = !deviceId || deviceId === 'default' ? null : deviceId;
    this.useSystemDefaultDevice = normalizedDeviceId === null;
    this.deviceId = normalizedDeviceId;

    if (this.recorderStarted) {
      await this.setInputDevice(normalizedDeviceId ?? 'default');
    }
  }

  /**
   * Restarts audio recording after a device switch to ensure audio is captured from the new device
   */
  private async _restartAudioRecording(): Promise<void> {
    if (!this.audioInput) {
      console.debug('Skipping audio recording restart because audio input is disabled');
      return;
    }
    try {
      console.debug('Restarting audio recording after device switch...');
      // Stop amplitude monitoring tied to the previous recording session before tearing it down
      this._stopRecorderAmplitudeMonitoring();
      try {
        await this.wavRecorder.end();
      } catch {
        // Ignore cleanup errors
      }

      // Start with new device
      const targetDeviceId = this.useSystemDefaultDevice ? undefined : this.deviceId || undefined;
      await this.wavRecorder.begin(targetDeviceId);
      await this.wavRecorder.record(this._handleDataAvailable, 1638);

      // Re-setup amplitude monitoring with the new stream
      this._setupAmplitudeMonitoring(this.wavRecorder, this.options.onUserAmplitudeChange, (amp) => (this.userAudioAmplitude = amp));
      if (!this.options.enableAmplitudeMonitoring) {
        this.userAudioAmplitude = 0;
      }

      const previousReportedDeviceId = this.lastReportedDeviceId;
      const stream = this.wavRecorder.getStream();
      const activeTrack = stream?.getAudioTracks()[0] || null;
      const trackSettings = activeTrack && typeof activeTrack.getSettings === 'function' ? activeTrack.getSettings() : null;
      const trackDeviceId = trackSettings && typeof trackSettings.deviceId === 'string' ? trackSettings.deviceId : null;
      this.activeDeviceId = trackDeviceId ?? (this.useSystemDefaultDevice ? null : this.deviceId);

      if (!this.recorderStarted) {
        this.recorderStarted = true;
        this._sendReadyIfNeeded();
      }

      const reportedDeviceId = this.activeDeviceId ?? (this.useSystemDefaultDevice ? 'default' : this.deviceId ?? 'default');
      if (reportedDeviceId !== previousReportedDeviceId) {
        this.lastReportedDeviceId = reportedDeviceId;
        if (this.options.onDeviceSwitched) {
          this.options.onDeviceSwitched(reportedDeviceId);
        }
      }

      console.debug('Audio recording restart completed successfully');
    } catch (error) {
      console.error('Error restarting audio recording after device switch:', error);
      this.options.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private _queueRecorderRestart(): Promise<void> {
    const run = this.recorderRestartChain.then(() => this._restartAudioRecording());
    this.recorderRestartChain = run.catch(() => {});
    return run;
  }

  private async _initializeRecorderWithDefaultDevice(): Promise<void> {
    console.log('_initializeRecorderWithDefaultDevice called, deviceChangeListener:', !!this.deviceChangeListener);
    if (!this.deviceChangeListener) {
      return;
    }

    try {
      const devices = await this.wavRecorder.listDevices();
      console.log('_initializeRecorderWithDefaultDevice: got devices:', devices.length);
      if (devices.length) {
        console.log('_initializeRecorderWithDefaultDevice: calling deviceChangeListener');
        await this.deviceChangeListener(devices);
        return;
      }
      console.warn('No audio input devices available when enabling microphone');
    } catch (error) {
      console.warn('Unable to prime audio devices from listDevices()', error);
    }

    try {
      console.log('_initializeRecorderWithDefaultDevice: calling setInputDevice default');
      await this.setInputDevice('default');
    } catch (error) {
      console.error('Failed to start recording with the system default device:', error);
      throw error;
    }
  }

  /**
   * Disconnect VAD
   */
  private stopVad(): void {
    if (this.vad) {
      this.vad.pause();
      this.vad.destroy();
      this.vad = null;
    }
    this._setUserSpeaking(false);
  }
  /**
   * Reinitializes VAD with a new stream (used after device switching)
   */
  private async _reinitializeVAD(stream: MediaStream | null): Promise<void> {
    this.stopVad();
    // Reinitialize with new stream only if we're actually capturing audio
    if (stream && this._shouldCaptureUserAudio()) {
      this._initializeVAD();
    }
  }

  /**
   * Sets up the device change event listener
   */
  private async _setupDeviceChangeListener(): Promise<void> {
    if (!this.deviceChangeListener) {
      this.deviceListenerReady = new Promise((resolve) => {
        const timeoutId = setTimeout(() => {
          this.resolveDeviceListenerReady = null;
          this.deviceListenerReady = null;
          resolve();
        }, 250);
        this.resolveDeviceListenerReady = () => {
          clearTimeout(timeoutId);
          this.resolveDeviceListenerReady = null;
          this.deviceListenerReady = null;
          resolve();
        };
      });

      this.deviceChangeListener = async (devices: any[]) => {
        console.log('deviceChangeListener called, devices:', devices.length, 'recorderStarted:', this.recorderStarted);
        try {
          // Notify user that devices have changed
          this.options.onDevicesChanged(devices);

          const defaultDevice = devices.find((device: any) => device.default);
          const usingDefaultDevice = this.useSystemDefaultDevice;
          const previousDefaultDeviceKey = this.lastKnownSystemDefaultDeviceKey;
          const currentDefaultDeviceKey = this._getDeviceComparisonKey(defaultDevice);

          let shouldSwitch = !this.recorderStarted;
          console.log('deviceChangeListener: shouldSwitch initial:', shouldSwitch);

          if (!shouldSwitch) {
            if (usingDefaultDevice) {
              if (!defaultDevice) {
                shouldSwitch = true;
              } else if (this.activeDeviceId && defaultDevice.deviceId !== 'default' && defaultDevice.deviceId !== this.activeDeviceId) {
                shouldSwitch = true;
              } else if (
                (previousDefaultDeviceKey && previousDefaultDeviceKey !== currentDefaultDeviceKey) ||
                (!previousDefaultDeviceKey && !currentDefaultDeviceKey && this.recorderStarted)
              ) {
                shouldSwitch = true;
              }
            } else {
              const matchesRequestedDevice = devices.some((device: any) => device.deviceId === this.deviceId || device.deviceId === this.activeDeviceId);
              shouldSwitch = !matchesRequestedDevice;
            }
          }

          this.lastKnownSystemDefaultDeviceKey = currentDefaultDeviceKey;

          console.log('deviceChangeListener: final shouldSwitch:', shouldSwitch);
          if (shouldSwitch) {
            console.debug('Selecting audio input device after change');

            let targetDeviceId: string | null = null;
            const preferredDeviceId = this.deviceId;
            const canUsePreferredDevice = !this.recorderStarted && !this.useSystemDefaultDevice && typeof preferredDeviceId === 'string';
            if (canUsePreferredDevice) {
              const preferredDeviceAvailable = devices.some((device: any) => device.deviceId === preferredDeviceId);
              if (preferredDeviceAvailable) {
                targetDeviceId = preferredDeviceId;
              }
            }

            if (!targetDeviceId) {
              const fallbackDevice = defaultDevice || devices[0];
              if (fallbackDevice) {
                targetDeviceId = fallbackDevice.default ? 'default' : fallbackDevice.deviceId;
              }
            }

            if (targetDeviceId) {
              await this.setInputDevice(targetDeviceId);
            } else {
              console.warn('No alternative audio device found');
            }
          }
        } catch (error) {
          this.options.onError(error instanceof Error ? error : new Error(String(error)));
        } finally {
          this.resolveDeviceListenerReady?.();
        }
      };

      this.wavRecorder.listenForDeviceChange(this.deviceChangeListener);
    }

    if (this.deviceListenerReady) {
      await this.deviceListenerReady;
    }
  }

  private _teardownDeviceListeners(): void {
    this.wavRecorder.listenForDeviceChange(null);
    this.deviceChangeListener = null;
    this.deviceListenerReady = null;
    this.resolveDeviceListenerReady = null;
  }

  private async _performDisconnectCleanup(): Promise<void> {
    this.deviceId = null;
    this.activeDeviceId = null;
    this.useSystemDefaultDevice = false;
    this.lastReportedDeviceId = null;
    this.lastKnownSystemDefaultDeviceKey = null;
    this.recorderStarted = false;
    this.readySent = false;

    this._stopAmplitudeMonitoring();
    this._teardownDeviceListeners();

    if (this.vad) {
      this.vad.pause();
      this.vad.destroy();
      this.vad = null;
    }

    await this.wavRecorder.quit();
    this.wavPlayer.stop?.();
    this.wavPlayer.disconnect();

    this._resetTurnTracking();

    this.options.conversationId = this.conversationId;

    this.userAudioAmplitude = 0;
    this.agentAudioAmplitude = 0;

    this._setStatus('disconnected');
    this.options.onDisconnect();
  }

  private _getDeviceComparisonKey(device: any): string | null {
    if (!device || typeof device !== 'object') {
      return null;
    }
    const deviceId = typeof device.deviceId === 'string' ? device.deviceId : '';
    if (deviceId && deviceId !== 'default') {
      return deviceId;
    }
    const groupId = typeof device.groupId === 'string' ? device.groupId : '';
    if (groupId) {
      return groupId;
    }
    const label = typeof device.label === 'string' ? device.label : '';
    if (label) {
      return label;
    }
    return null;
  }

  /**
   * Mutes the microphone to stop sending audio to the server
   * The connection and recording remain active for quick unmute
   */
  mute(): void {
    if (!this.isMuted) {
      this.isMuted = true;
      console.log('Microphone muted');
      this.options.onMuteStateChange(true);
      this.stopVad();
      this._stopRecorderAmplitudeMonitoring();
    }
  }

  /**
   * Unmutes the microphone to resume sending audio to the server
   */
  unmute(): void {
    if (this.isMuted) {
      this.isMuted = false;
      console.log('Microphone unmuted');
      this.options.onMuteStateChange(false);
      if (this.audioInput && this.recorderStarted) {
        this._initializeVAD();
        if (this.stopRecorderAmplitude === undefined) {
          this._setupAmplitudeMonitoring(this.wavRecorder, this.options.onUserAmplitudeChange, (amp) => (this.userAudioAmplitude = amp));
        }
      } else {
        console.debug('Audio input is disabled or recorder not ready; deferring VAD restart until microphone is active');
      }
    }
  }
}

export default LayercodeClient;
export type { ILayercodeClient, LayercodeClientOptions, AuthorizeSessionRequest, AuthorizeSessionRequestParams };
