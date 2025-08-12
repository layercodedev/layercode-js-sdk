/* eslint-env browser */
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
  ClientTriggerResponseAudioInterruptedMessage,
  ClientVadEventsMessage,
} from './interfaces.js';

interface PipelineConfig {
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

// SDK version - updated when publishing
const SDK_VERSION = '1.0.26';

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
  readonly status: string;
  readonly userAudioAmplitude: number;
  readonly agentAudioAmplitude: number;
  readonly sessionId: string | null;
}

/**
 * Interface for LayercodeClient constructor options
 */
interface LayercodeClientOptions {
  /** The ID of the Layercode pipeline to connect to */
  pipelineId: string;
  /** The ID of the session to connect to */
  sessionId?: string | null;
  /** The endpoint URL for the audio agent API */
  authorizeSessionEndpoint: string;
  /** Metadata to send with webhooks */
  metadata?: Record<string, any>;
  /** Milliseconds before resuming assistant audio after temporary pause due to user interruption (which was actually a false interruption) */
  vadResumeDelay?: number;
  /** Callback when connection is established */
  onConnect?: ({ sessionId }: { sessionId: string | null }) => void;
  /** Callback when connection is closed */
  onDisconnect?: () => void;
  /** Callback when an error occurs */
  onError?: (error: Error) => void;
  /** Callback for data messages */
  onDataMessage?: (message: any) => void;
  /** Callback for user audio amplitude changes */
  onUserAmplitudeChange?: (amplitude: number) => void;
  /** Callback for agent audio amplitude changes */
  onAgentAmplitudeChange?: (amplitude: number) => void;
  /** Callback when connection status changes */
  onStatusChange?: (status: string) => void;
  /** Callback when user turn changes */
  onUserIsSpeakingChange?: (isSpeaking: boolean) => void;
}

/**
 * @class LayercodeClient
 * @classdesc Core client for Layercode audio pipeline that manages audio recording, WebSocket communication, and speech processing.
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
  private vadConfig: PipelineConfig['vad'] | null;
  // private audioPauseTime: number | null; // Track when audio was paused for VAD
  _websocketUrl: string;
  status: string;
  userAudioAmplitude: number;
  agentAudioAmplitude: number;
  sessionId: string | null;

  /**
   * Creates an instance of LayercodeClient.
   * @param {Object} options - Configuration options
   */
  constructor(options: LayercodeClientOptions) {
    this.options = {
      pipelineId: options.pipelineId,
      sessionId: options.sessionId || null,
      authorizeSessionEndpoint: options.authorizeSessionEndpoint,
      metadata: options.metadata || {},
      vadResumeDelay: options.vadResumeDelay || 500,
      onConnect: options.onConnect || (() => {}),
      onDisconnect: options.onDisconnect || (() => {}),
      onError: options.onError || (() => {}),
      onDataMessage: options.onDataMessage || (() => {}),
      onUserAmplitudeChange: options.onUserAmplitudeChange || (() => {}),
      onAgentAmplitudeChange: options.onAgentAmplitudeChange || (() => {}),
      onStatusChange: options.onStatusChange || (() => {}),
      onUserIsSpeakingChange: options.onUserIsSpeakingChange || (() => {}),
    };

    this.AMPLITUDE_MONITORING_SAMPLE_RATE = 10;
    this._websocketUrl = 'wss://api.layercode.com/v1/pipelines/websocket';

    this.wavRecorder = new WavRecorder({ sampleRate: 8000 }); // TODO should be set my fetched pipeline config
    this.wavPlayer = new WavStreamPlayer({
      finishedPlayingCallback: this._clientResponseAudioReplayFinished.bind(this),
      sampleRate: 16000, // TODO should be set my fetched pipeline config
    });
    this.vad = null;
    this.ws = null;
    this.status = 'disconnected';
    this.userAudioAmplitude = 0;
    this.agentAudioAmplitude = 0;
    this.sessionId = options.sessionId || null;
    this.pushToTalkActive = false;
    this.pushToTalkEnabled = false;
    this.canInterrupt = false;
    this.userIsSpeaking = false;
    this.recorderStarted = false;
    this.readySent = false;
    this.currentTurnId = null;
    this.audioBuffer = [];
    this.vadConfig = null;
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
        console.log('onSpeechStart: sending vad_start');
        this.userIsSpeaking = true;
        this.options.onUserIsSpeakingChange(true);
        this._wsSend({
          type: 'vad_events',
          event: 'vad_start',
        } as ClientVadEventsMessage);
      },
      onSpeechEnd: () => {
        console.log('onSpeechEnd: sending vad_end');
        this.userIsSpeaking = false;
        this.options.onUserIsSpeakingChange(false);
        this.audioBuffer = []; // Clear buffer on speech end
        this._wsSend({
          type: 'vad_events',
          event: 'vad_end',
        } as ClientVadEventsMessage);
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
        console.error('Error initializing VAD:', error);
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
    console.log('clientResponseAudioReplayFinished');
    this._wsSend({
      type: 'trigger.response.audio.replay_finished',
      reason: 'completed',
    } as ClientTriggerResponseAudioReplayFinishedMessage);
  }

  private async _clientInterruptAssistantReplay(): Promise<void> {
    const offsetData = await this.wavPlayer.interrupt();

    if (offsetData && this.currentTurnId) {
      let offsetMs = offsetData.currentTime * 1000;

      // Send interruption event with accurate playback offset in milliseconds
      this._wsSend({
        type: 'trigger.response.audio.interrupted',
        playback_offset: offsetMs,
        interruption_context: {
          turn_id: this.currentTurnId,
          playback_offset_ms: offsetMs,
        },
      } as ClientTriggerResponseAudioInterruptedMessage);
    } else {
      console.warn('Interruption requested but missing required data:', {
        hasOffsetData: !!offsetData,
        hasTurnId: !!this.currentTurnId,
      });
    }
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
        console.log('received ws msg:', message);
      }

      switch (message.type) {
        case 'turn.start':
          // Sent from the server to this client when a new user turn is detected
          console.log('received turn.start from server');
          console.log(message);
          if (message.role === 'assistant') {
            // Start tracking new assistant turn
            console.log('Assistant turn started, will track new turn ID from audio/text');
          } else if (message.role === 'user' && !this.pushToTalkEnabled) {
            // Interrupt any playing assistant audio if this is a turn triggered by the server (and not push to talk, which will have already called interrupt)
            console.log('interrupting assistant audio, as user turn has started and pushToTalkEnabled is false');
            await this._clientInterruptAssistantReplay();
          }
          break;

        case 'response.audio':
          const audioBuffer = base64ToArrayBuffer(message.content);
          this.wavPlayer.add16BitPCM(audioBuffer, message.turn_id);

          // Set current turn ID from first audio message, or update if different turn
          if (!this.currentTurnId || this.currentTurnId !== message.turn_id) {
            console.log(`Setting current turn ID to: ${message.turn_id} (was: ${this.currentTurnId})`);
            this.currentTurnId = message.turn_id;

            // Clean up interrupted tracks, keeping only the current turn
            this.wavPlayer.clearInterruptedTracks(this.currentTurnId ? [this.currentTurnId] : []);
          }
          break;

        case 'response.text': {
          // Set turn ID from first text message if not set
          if (!this.currentTurnId) {
            this.currentTurnId = message.turn_id;
            console.log(`Setting current turn ID to: ${message.turn_id} from text message`);
          }
          break;
        }
        case 'response.data':
          console.log('received response.data', message);
          this.options.onDataMessage(message);
          break;
        default:
          console.error('Unknown message type received:', message);
          break;
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
          console.log(`Sending ${this.audioBuffer.length} buffered audio chunks`);
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
      console.log('sent ws msg:', message);
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
    // Set up amplitude monitoring only if a callback is provided
    // Check against the default no-op function defined in the constructor options
    if (callback !== (() => {})) {
      let updateCounter = 0;
      source.startAmplitudeMonitoring((amplitude: number) => {
        // Only update and call callback at the specified sample rate
        if (updateCounter >= this.AMPLITUDE_MONITORING_SAMPLE_RATE) {
          updateInternalState(amplitude);
          callback(amplitude);
          updateCounter = 0; // Reset counter after sampling
        }
        updateCounter++;
      });
    }
  }

  /**
   * Connects to the Layercode pipeline and starts the audio session
   * @async
   * @returns {Promise<void>}
   */
  async connect(): Promise<void> {
    try {
      this._setStatus('connecting');

      // Reset turn tracking for clean start
      this._resetTurnTracking();

      // Get session key from server
      let authorizeSessionRequestBody = {
        pipeline_id: this.options.pipelineId,
        metadata: this.options.metadata,
        sdk_version: SDK_VERSION,
      } as { pipeline_id: string; metadata: Record<string, any>; sdk_version: string; session_id?: string };
      // If we're reconnecting to a previous session, we need to include the session_id in the request. Otherwise we don't send session_id, and a new session will be created and the session_id will be returned in the response.
      if (this.options.sessionId) {
        authorizeSessionRequestBody.session_id = this.options.sessionId;
      }
      const authorizeSessionResponse = await fetch(this.options.authorizeSessionEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(authorizeSessionRequestBody),
      });
      if (!authorizeSessionResponse.ok) {
        throw new Error(`Failed to authorize session: ${authorizeSessionResponse.statusText}`);
      }
      const authorizeSessionResponseBody = await authorizeSessionResponse.json();
      this.sessionId = authorizeSessionResponseBody.session_id; // Save the session_id for use in future reconnects

      // Connect WebSocket
      this.ws = new WebSocket(
        `${this._websocketUrl}?${new URLSearchParams({
          client_session_key: authorizeSessionResponseBody.client_session_key,
        })}`
      );
      const config: PipelineConfig = authorizeSessionResponseBody.config;
      console.log('config', config);

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
      this._initializeVAD();

      // Bind the websocket message callbacks
      this.ws.onmessage = this._handleWebSocketMessage;
      this.ws.onopen = () => {
        console.log('WebSocket connection established');
        this._setStatus('connected');
        this.options.onConnect({ sessionId: this.sessionId });

        // Attempt to send ready message if recorder already started
        this._sendReadyIfNeeded();
      };
      this.ws.onclose = () => {
        console.log('WebSocket connection closed');
        this._setStatus('disconnected');
        this.options.onDisconnect();
      };
      this.ws.onerror = (error: Event) => {
        console.error('WebSocket error:', error);
        this._setStatus('error');
        this.options.onError(new Error('WebSocket connection error'));
      };

      // Initialize microphone audio capture
      await this.wavRecorder.begin();
      await this.wavRecorder.record(this._handleDataAvailable, 1638);
      // Set up microphone amplitude monitoring
      this._setupAmplitudeMonitoring(this.wavRecorder, this.options.onUserAmplitudeChange, (amp) => (this.userAudioAmplitude = amp));

      // Initialize audio player
      await this.wavPlayer.connect();
      // Set up audio player amplitude monitoring
      this._setupAmplitudeMonitoring(this.wavPlayer, this.options.onAgentAmplitudeChange, (amp) => (this.agentAudioAmplitude = amp));

      // Mark recorder as started and attempt to notify server
      this.recorderStarted = true;
      this._sendReadyIfNeeded();
    } catch (error) {
      console.error('Error connecting to Layercode pipeline:', error);
      this._setStatus('error');
      this.options.onError(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  private _resetTurnTracking(): void {
    this.currentTurnId = null;
    console.log('Reset turn tracking state');
  }

  async disconnect(): Promise<void> {
    // Clean up VAD if it exists
    if (this.vad) {
      this.vad.pause();
      this.vad.destroy();
      this.vad = null;
    }

    this.wavRecorder.quit();
    this.wavPlayer.disconnect();

    // Reset turn tracking
    this._resetTurnTracking();

    // Close websocket and ensure status is updated
    if (this.ws) {
      this.ws.close();
      this._setStatus('disconnected');
      this.options.onDisconnect();
    }
  }

  /**
   * Gets the microphone MediaStream used by this client
   * @returns {MediaStream|null} The microphone stream or null if not initialized
   */
  getStream(): MediaStream | null {
    return this.wavRecorder.getStream();
  }

  /**
   * Switches the input device for the microphone and restarts recording
   * @param {string} deviceId - The deviceId of the new microphone
   */
  async setInputDevice(deviceId: string): Promise<void> {
    if (this.wavRecorder) {
      try {
        await this.wavRecorder.end();
      } catch (e) {}
      try {
        await this.wavRecorder.quit();
      } catch (e) {}
    }
    await this.wavRecorder.begin(deviceId);
    await this.wavRecorder.record(this._handleDataAvailable, 1638);
    this._setupAmplitudeMonitoring(this.wavRecorder, this.options.onUserAmplitudeChange, (amp) => (this.userAudioAmplitude = amp));
  }
}

export default LayercodeClient;
export type { ILayercodeClient, LayercodeClientOptions };
