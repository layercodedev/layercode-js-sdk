/* eslint-env browser */
// import { env as ortEnv } from 'onnxruntime-web';
import { WavRecorder, WavStreamPlayer } from './wavtools/index.js';
// @ts-ignore - VAD package does not provide TypeScript types
import { MicVAD } from '@ricky0123/vad-web';
import { base64ToArrayBuffer, arrayBufferToBase64 } from './utils.js';
import {
  ClientMessage,
  ServerMessage,
  ClientAudioMessage,
  ClientTriggerTurnMessage,
  ClientTriggerResponseAudioReplayFinishedMessage,
  ClientVadEventsMessage,
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

const NOOP = () => {};
const DEFAULT_WS_URL = 'wss://api.layercode.com/v1/agents/web/websocket';

// SDK version - updated when publishing
const SDK_VERSION = '2.1.3';

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
  listDevices(): Promise<Array<MediaDeviceInfo & { default: boolean }>>;
  mute(): void;
  unmute(): void;
  readonly status: string;
  readonly userAudioAmplitude: number;
  readonly agentAudioAmplitude: number;
  readonly isMuted: boolean;
  readonly conversationId: string | null;
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
  /** Metadata to send with webhooks */
  metadata?: Record<string, any>;
  /** Milliseconds before resuming assistant audio after temporary pause due to user interruption (which was actually a false interruption) */
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
  /** Callback when mute state changes */
  onMuteStateChange?: (isMuted: boolean) => void;
}

/**
 * @class LayercodeClient
 * @classdesc Core client for Layercode audio agent that manages audio recording, WebSocket communication, and speech processing.
 */
class LayercodeClient implements ILayercodeClient {
  private options: Required<LayercodeClientOptions>;
  private wavRecorder: WavRecorder;
  private wavPlayer: WavStreamPlayer;
  private vad: MicVAD | null;
  private ws: WebSocket | null;
  private AMPLITUDE_MONITORING_SAMPLE_RATE: number;
  private pushToTalkActive: boolean;
  private pushToTalkEnabled: boolean;
  private canInterrupt: boolean;
  private userIsSpeaking: boolean;
  private recorderStarted: boolean; // Indicates that WavRecorder.record() has been called successfully
  private readySent: boolean; // Ensures we send client.ready only once
  private currentTurnId: string | null; // Track current turn ID
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
      metadata: options.metadata ?? {},
      vadResumeDelay: options.vadResumeDelay ?? 500,
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
      onMuteStateChange: options.onMuteStateChange ?? NOOP,
    };

    this.AMPLITUDE_MONITORING_SAMPLE_RATE = 2;
    this._websocketUrl = DEFAULT_WS_URL;

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
    this.recorderStarted = false;
    this.readySent = false;
    this.currentTurnId = null;
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
    // this.audioPauseTime = null;

    // Bind event handlers
    this._handleWebSocketMessage = this._handleWebSocketMessage.bind(this);
    this._handleDataAvailable = this._handleDataAvailable.bind(this);
  }

  private _initializeVAD(): void {
    console.log('initializing VAD', { pushToTalkEnabled: this.pushToTalkEnabled, canInterrupt: this.canInterrupt, vadConfig: this.vadConfig });

    // If we're in push to talk mode, we don't need to use the VAD model
    if (this.pushToTalkEnabled) {
      return;
    }

    // Check if VAD is disabled
    if (this.vadConfig?.enabled === false) {
      console.log('VAD is disabled by backend configuration');
      return;
    }

    // Build VAD configuration object, only including keys that are defined
    const vadOptions: any = {
      stream: this.wavRecorder.getStream() || undefined,
      onSpeechStart: () => {
        console.debug('onSpeechStart: sending vad_start');
        this.userIsSpeaking = true;
        this.options.onUserIsSpeakingChange(true);
        this._wsSend({
          type: 'vad_events',
          event: 'vad_start',
        } as ClientVadEventsMessage);
        this.options.onMessage({
          type: 'vad_events',
          event: 'vad_start',
        });
      },
      onSpeechEnd: () => {
        console.debug('onSpeechEnd: sending vad_end');
        this.userIsSpeaking = false;
        this.options.onUserIsSpeakingChange(false);
        this.audioBuffer = []; // Clear buffer on speech end
        this._wsSend({
          type: 'vad_events',
          event: 'vad_end',
        } as ClientVadEventsMessage);
        this.options.onMessage({
          type: 'vad_events',
          event: 'vad_end',
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
        this._wsSend({
          type: 'vad_events',
          event: 'vad_model_failed',
        } as ClientVadEventsMessage);
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

  /**
   * Handles when agent audio finishes playing
   */
  private _clientResponseAudioReplayFinished(): void {
    console.debug('clientResponseAudioReplayFinished');
    this._wsSend({
      type: 'trigger.response.audio.replay_finished',
      reason: 'completed',
    } as ClientTriggerResponseAudioReplayFinishedMessage);
  }

  private async _clientInterruptAssistantReplay(): Promise<void> {
    await this.wavPlayer.interrupt();
  }

  async triggerUserTurnStarted(): Promise<void> {
    if (!this.pushToTalkActive) {
      this.pushToTalkActive = true;
      this._wsSend({ type: 'trigger.turn.start', role: 'user' } as ClientTriggerTurnMessage);
      await this._clientInterruptAssistantReplay();
    }
  }

  async triggerUserTurnFinished(): Promise<void> {
    if (this.pushToTalkActive) {
      this.pushToTalkActive = false;
      this._wsSend({ type: 'trigger.turn.end', role: 'user' } as ClientTriggerTurnMessage);
    }
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
        case 'turn.start':
          // Sent from the server to this client when a new user turn is detected
          if (message.role === 'assistant') {
            // Start tracking new assistant turn
            console.debug('Assistant turn started, will track new turn ID from audio/text');
          } else if (message.role === 'user' && !this.pushToTalkEnabled) {
            // Interrupt any playing assistant audio if this is a turn triggered by the server (and not push to talk, which will have already called interrupt)
            console.debug('interrupting assistant audio, as user turn has started and pushToTalkEnabled is false');
            await this._clientInterruptAssistantReplay();
          }
          this.options.onMessage(message);
          break;

        case 'response.audio':
          const audioBuffer = base64ToArrayBuffer(message.content);
          this.wavPlayer.add16BitPCM(audioBuffer, message.turn_id);

          // TODO: once we've added turn_id to the turn.start msgs sent from teh server, we should move this currentTurnId switching logic to the turn.start msg case. We can then remove the currentTurnId setting logic from the response.audio and response.text cases.
          // Set current turn ID from first audio message, or update if different turn
          if (!this.currentTurnId || this.currentTurnId !== message.turn_id) {
            console.debug(`Setting current turn ID to: ${message.turn_id} (was: ${this.currentTurnId})`);
            this.currentTurnId = message.turn_id;

            // Clean up interrupted tracks, keeping only the current turn
            this.wavPlayer.clearInterruptedTracks(this.currentTurnId ? [this.currentTurnId] : []);
          }
          break;

        case 'response.text':
          // Set turn ID from first text message if not set
          if (!this.currentTurnId) {
            this.currentTurnId = message.turn_id;
            console.debug(`Setting current turn ID to: ${message.turn_id} from text message`);
          }
          this.options.onMessage(message);
          break;

        case 'response.data':
          this.options.onDataMessage(message);
          break;

        case 'user.transcript':
        case 'user.transcript.delta':
        case 'user.transcript.interim_delta':
          this.options.onMessage(message);
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
    if (this.recorderStarted && this.ws?.readyState === WebSocket.OPEN && !this.readySent) {
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
    source.startAmplitudeMonitoring((amplitude: number) => {
      // Only update and call callback at the specified sample rate
      if (updateCounter >= this.AMPLITUDE_MONITORING_SAMPLE_RATE) {
        updateInternalState(amplitude);
        if (callback !== NOOP) {
          callback(amplitude);
        }
        updateCounter = 0; // Reset counter after sampling
      }
      updateCounter++;
    });

    const stop = () => source.stopAmplitudeMonitoring?.();
    if (source === this.wavPlayer) {
      this.stopPlayerAmplitude = stop;
    }
    if (source === this.wavRecorder) {
      this.stopRecorderAmplitude = stop;
    }
  }

  private _stopAmplitudeMonitoring(): void {
    this.stopPlayerAmplitude?.();
    this.stopRecorderAmplitude?.();
    this.stopPlayerAmplitude = undefined;
    this.stopRecorderAmplitude = undefined;
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
      let authorizeSessionRequestBody = {
        agent_id: this.options.agentId,
        metadata: this.options.metadata,
        sdk_version: SDK_VERSION,
      } as { agent_id: string; metadata: Record<string, any>; sdk_version: string; conversation_id?: string };
      // If we're reconnecting to a previous conversation, we need to include the conversation_id in the request. Otherwise we don't send conversation_id, and a new conversation will be created and the conversation_id will be returned in the response.
      if (this.options.conversationId) {
        authorizeSessionRequestBody.conversation_id = this.options.conversationId;
      }
      const authorizeSessionResponse = await fetch(this.options.authorizeSessionEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(authorizeSessionRequestBody),
      });
      if (!authorizeSessionResponse.ok) {
        throw new Error(`Failed to authorize conversation: ${authorizeSessionResponse.statusText}`);
      }
      const authorizeSessionResponseBody = await authorizeSessionResponse.json();
      this.conversationId = authorizeSessionResponseBody.conversation_id; // Save the conversation_id for use in future reconnects
      this.options.conversationId = this.conversationId;

      await this.wavRecorder.requestPermission();
      this._setupDeviceChangeListener();

      // Connect WebSocket
      this.ws = new WebSocket(
        `${this._websocketUrl}?${new URLSearchParams({
          client_session_key: authorizeSessionResponseBody.client_session_key,
        })}`
      );
      const config: AgentConfig = authorizeSessionResponseBody.config;
      console.log('AgentConfig', config);

      // Store VAD configuration
      this.vadConfig = config.vad || null;

      if (config.transcription.trigger === 'push_to_talk') {
        this.pushToTalkEnabled = true;
      } else if (config.transcription.trigger === 'automatic') {
        this.pushToTalkEnabled = false;
        this.canInterrupt = config.transcription.can_interrupt;
      } else {
        throw new Error(`Unknown trigger: ${config.transcription.trigger}`);
      }

      // Bind the websocket message callbacks
      this.ws.onmessage = this._handleWebSocketMessage;
      this.ws.onopen = () => {
        console.log('WebSocket connection established');
        this._setStatus('connected');
        this.options.onConnect({ conversationId: this.conversationId, config });

        // Attempt to send ready message if recorder already started
        this._sendReadyIfNeeded();
      };
      this.ws.onclose = () => {
        console.log('WebSocket connection closed');
        this.ws = null;
        this._performDisconnectCleanup().catch((error) => {
          console.error('Error during disconnect cleanup:', error);
          this.options.onError(error instanceof Error ? error : new Error(String(error)));
        });
      };
      this.ws.onerror = (error: Event) => {
        console.error('WebSocket error:', error);
        this._setStatus('error');
        this.options.onError(new Error('WebSocket connection error'));
      };

      // Initialize audio player
      await this.wavPlayer.connect();
      // Set up audio player amplitude monitoring
      this._setupAmplitudeMonitoring(this.wavPlayer, this.options.onAgentAmplitudeChange, (amp) => (this.agentAudioAmplitude = amp));

      // wavRecorder will be started from the onDeviceSwitched callback,
      // which is called when the device is first initialized and also when the device is switched
      // this is to ensure that the device is initialized before the recorder is started
    } catch (error) {
      console.error('Error connecting to Layercode agent:', error);
      this._setStatus('error');
      this.options.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private _resetTurnTracking(): void {
    this.currentTurnId = null;
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
    try {
      const normalizedDeviceId = !deviceId || deviceId === 'default' ? null : deviceId;
      this.useSystemDefaultDevice = normalizedDeviceId === null;
      this.deviceId = normalizedDeviceId;

      // Restart recording with the new device
      await this._restartAudioRecording();

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

  /**
   * Restarts audio recording after a device switch to ensure audio is captured from the new device
   */
  private async _restartAudioRecording(): Promise<void> {
    try {
      console.debug('Restarting audio recording after device switch...');
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

  /**
   * Reinitializes VAD with a new stream (used after device switching)
   */
  private async _reinitializeVAD(stream: MediaStream | null): Promise<void> {
    // Clean up existing VAD
    if (this.vad) {
      this.vad.pause();
      this.vad.destroy();
      this.vad = null;
    }

    // Reinitialize with new stream
    if (stream) {
      this._initializeVAD();
    }
  }

  /**
   * Sets up the device change event listener
   */
  private _setupDeviceChangeListener(): void {
    if (!this.deviceChangeListener) {
      this.deviceChangeListener = async (devices: any[]) => {
        try {
          // Notify user that devices have changed
          this.options.onDevicesChanged(devices);

          const defaultDevice = devices.find((device: any) => device.default);
          const usingDefaultDevice = this.useSystemDefaultDevice;
          const previousDefaultDeviceKey = this.lastKnownSystemDefaultDeviceKey;
          const currentDefaultDeviceKey = this._getDeviceComparisonKey(defaultDevice);

          let shouldSwitch = !this.recorderStarted;

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

          if (shouldSwitch) {
            console.debug('Selecting fallback audio input device');
            const fallbackDevice = defaultDevice || devices[0];
            if (fallbackDevice) {
              const fallbackId = fallbackDevice.default ? 'default' : fallbackDevice.deviceId;
              await this.setInputDevice(fallbackId);
            } else {
              console.warn('No alternative audio device found');
            }
          }
        } catch (error) {
          this.options.onError(error instanceof Error ? error : new Error(String(error)));
        }
      };
    }

    this.wavRecorder.listenForDeviceChange(this.deviceChangeListener);
  }

  private _teardownDeviceListeners(): void {
    this.wavRecorder.listenForDeviceChange(null);
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
    }
  }
}

export default LayercodeClient;
export type { AgentConfig, ILayercodeClient, LayercodeClientOptions };
