/* eslint-env browser */
import { WavRecorder, WavStreamPlayer } from './wavtools/index.js';
import { arrayBufferToBase64 } from './utils';
import { VADManager, VADConfig } from './vad-manager';
import { WebSocketManager } from './websocket';

interface PipelineConfig {
  transcription: {
    trigger: 'push_to_talk' | 'automatic';
    can_interrupt: boolean;
    automatic: boolean;
  };
  vad?: VADConfig;
}

// SDK version - updated when publishing
const SDK_VERSION = '1.0.27';

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
  getDefaultDeviceId(): Promise<string | null>;
  getAudioDevices(): Promise<Array<MediaDeviceInfo & { default: boolean; current: boolean }>>;
  getCurrentDeviceId(): string | null;
  refreshAudioDevices(): Promise<Array<MediaDeviceInfo & { default: boolean; current: boolean }>>;
  logDeviceStatus(): Promise<void>;
  forceVADReinitialization(): Promise<void>;
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
  private vadManager: VADManager;
  private websocketManager: WebSocketManager;
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

    // Initialize WebSocket manager
    this.websocketManager = new WebSocketManager({
      onConnect: this.options.onConnect,
      onDisconnect: this.options.onDisconnect,
      onError: this.options.onError,
      onDataMessage: this.options.onDataMessage,
      onTurnStart: this._handleTurnStart.bind(this),
      onResponseAudio: this._handleResponseAudio.bind(this),
      onResponseText: this._handleResponseText.bind(this),
      onStatusChange: this._setStatus.bind(this),
    });

    // Initialize VAD manager
    this.vadManager = new VADManager({
      onSpeechStart: () => {
        this.userIsSpeaking = true;
        this.options.onUserIsSpeakingChange(true);
        this.websocketManager.sendVADEvent('vad_start');
      },
      onSpeechEnd: () => {
        this.userIsSpeaking = false;
        this.options.onUserIsSpeakingChange(false);
        this.audioBuffer = []; // Clear buffer on speech end
        this.websocketManager.sendVADEvent('vad_end');
      },
      onVADFailure: (error: any) => {
        this.websocketManager.sendVADEvent('vad_model_failed');
      },
      onStatusChange: (status: string) => {
        // VAD status changes can be handled here if needed
      },
    });
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
    this._handleDataAvailable = this._handleDataAvailable.bind(this);
  }

  private _initializeVAD(): void {
    const currentStream = this.wavRecorder.getStream();
    this.vadManager.initialize(this.vadConfig || null, currentStream, this.pushToTalkEnabled);
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
    this.websocketManager.sendAudioReplayFinished(this.currentTurnId || '');
  }

  private async _clientInterruptAssistantReplay(): Promise<void> {
    const offsetData = await this.wavPlayer.interrupt();

    if (offsetData && this.currentTurnId) {
      let offsetMs = offsetData.currentTime * 1000;

      // Send interruption event with accurate playback offset in milliseconds
      this.websocketManager.sendAudioInterrupted(this.currentTurnId);
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
      this.websocketManager.sendTurnStart('user');
      await this._clientInterruptAssistantReplay();
    }
  }

  async triggerUserTurnFinished(): Promise<void> {
    if (this.pushToTalkActive) {
      this.pushToTalkActive = false;
      this.websocketManager.sendTurnEnd('user');
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
            this.websocketManager.sendAudio(bufferedAudio);
          }
          this.audioBuffer = []; // Clear the buffer after sending
        }

        // Send the current audio
        this.websocketManager.sendAudio(base64);
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

  private _sendReadyIfNeeded(): void {
    if (this.recorderStarted && this.websocketManager.isConnected() && !this.readySent) {
      this.websocketManager.sendClientReady();
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

      // Set session ID in WebSocket manager before connecting
      this.websocketManager.setSessionId(authorizeSessionResponseBody.session_id);

      // Connect WebSocket using the manager
      await this.websocketManager.connect({
        url: this._websocketUrl,
        clientSessionKey: authorizeSessionResponseBody.client_session_key,
      });

      // Initialize microphone audio capture
      await this.wavRecorder.begin();

      // Log the initial device selection for debugging
      const initialStream = this.wavRecorder.getStream();
      if (initialStream) {
        const tracks = initialStream.getAudioTracks();
        if (tracks.length > 0) {
          const track = tracks[0];
          const settings = track.getSettings();
          console.log('Initial microphone device selected:', {
            deviceId: settings.deviceId,
            label: track.label,
            enabled: track.enabled,
            muted: track.muted,
          });
        }
      }

      await this.wavRecorder.record(this._handleDataAvailable, 1638);

      // Initialize VAD now that we have an audio stream
      this._initializeVAD();

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

  /**
   * Handles turn start messages from WebSocket
   */
  private _handleTurnStart(message: any): void {
    console.log('received turn.start from server');
    console.log(message);
    if (message.role === 'assistant') {
      // Start tracking new assistant turn
      console.log('Assistant turn started, will track new turn ID from audio/text');
    } else if (message.role === 'user' && !this.pushToTalkEnabled) {
      // Interrupt any playing assistant audio if this is a turn triggered by the server (and not push to talk, which will have already called interrupt)
      console.log('interrupting assistant audio, as user turn has started and pushToTalkEnabled is false');
      this._clientInterruptAssistantReplay();
    }
  }

  /**
   * Handles response audio messages from WebSocket
   */
  private _handleResponseAudio(audioBuffer: ArrayBuffer, turnId: string): void {
    this.wavPlayer.add16BitPCM(audioBuffer, turnId);

    // Set current turn ID from first audio message, or update if different turn
    if (!this.currentTurnId || this.currentTurnId !== turnId) {
      console.log(`Setting current turn ID to: ${turnId} (was: ${this.currentTurnId})`);
      this.currentTurnId = turnId;

      // Clean up interrupted tracks, keeping only the current turn
      this.wavPlayer.clearInterruptedTracks(this.currentTurnId ? [this.currentTurnId] : []);
    }
  }

  /**
   * Handles response text messages from WebSocket
   */
  private _handleResponseText(message: any): void {
    // Set turn ID from first text message if not set
    if (!this.currentTurnId) {
      this.currentTurnId = message.turn_id;
      console.log(`Setting current turn ID to: ${message.turn_id} from text message`);
    }
  }

  private _resetTurnTracking(): void {
    this.currentTurnId = null;
    console.log('Reset turn tracking state');
  }

  async disconnect(): Promise<void> {
    // Clean up VAD if it exists
    this.vadManager.destroy();

    this.wavRecorder.quit();
    this.wavPlayer.disconnect();

    // Reset turn tracking
    this._resetTurnTracking();

    // Close websocket and ensure status is updated
    this.websocketManager.disconnect();
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
    try {
      console.log(`Switching to input device: ${deviceId}`);

      if (this.wavRecorder) {
        try {
          await this.wavRecorder.end();
        } catch (e) {
          console.warn('Error ending recorder:', e);
        }
        try {
          await this.wavRecorder.quit();
        } catch (e) {
          console.warn('Error quitting recorder:', e);
        }
      }

      await this.wavRecorder.begin(deviceId);
      await this.wavRecorder.record(this._handleDataAvailable, 1638);
      this._setupAmplitudeMonitoring(this.wavRecorder, this.options.onUserAmplitudeChange, (amp) => (this.userAudioAmplitude = amp));

      // Reinitialize VAD with the new audio stream if VAD is enabled
      if (this.vadManager.isVADEnabled()) {
        console.log('Reinitializing VAD with new audio stream');
        const newStream = this.wavRecorder.getStream();
        this.vadManager.reinitialize(newStream);
      }

      console.log(`Successfully switched to input device: ${deviceId}`);
    } catch (error) {
      console.error(`Failed to switch to input device ${deviceId}:`, error);
      throw new Error(`Failed to switch to input device: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Gets the default microphone device ID
   * @returns {Promise<string|null>} The default device ID or null if no default device found
   */
  async getDefaultDeviceId(): Promise<string | null> {
    try {
      const devices = await this.wavRecorder.listDevices();
      const defaultDevice = devices.find((device) => device.default === true);
      return defaultDevice ? defaultDevice.deviceId : null;
    } catch (error) {
      console.error('Error getting default device:', error);
      return null;
    }
  }

  /**
   * Gets all available audio input devices with their current status
   * @returns {Promise<Array<MediaDeviceInfo & { default: boolean, current: boolean }>>}
   */
  async getAudioDevices(): Promise<Array<MediaDeviceInfo & { default: boolean; current: boolean }>> {
    try {
      const devices = await this.wavRecorder.listDevices();
      const currentStream = this.wavRecorder.getStream();
      const currentTrack = currentStream?.getAudioTracks()[0];

      return devices.map((device) => ({
        ...device,
        current: currentTrack ? device.deviceId === currentTrack.getSettings().deviceId : false,
      }));
    } catch (error) {
      console.error('Error getting audio devices:', error);
      return [];
    }
  }

  /**
   * Gets the currently active audio input device ID
   * @returns {string|null} The current device ID or null if no device is active
   */
  getCurrentDeviceId(): string | null {
    try {
      const currentStream = this.wavRecorder.getStream();
      const currentTrack = currentStream?.getAudioTracks()[0];
      const deviceId = currentTrack?.getSettings().deviceId;
      return deviceId || null;
    } catch (error) {
      console.error('Error getting current device ID:', error);
      return null;
    }
  }

  /**
   * Refreshes the device list by requesting new permissions and re-enumerating devices
   * @returns {Promise<Array<MediaDeviceInfo & { default: boolean, current: boolean }>>}
   */
  async refreshAudioDevices(): Promise<Array<MediaDeviceInfo & { default: boolean; current: boolean }>> {
    try {
      // Request permissions again to refresh the device list
      await this.wavRecorder.requestPermission();
      return await this.getAudioDevices();
    } catch (error) {
      console.error('Error refreshing audio devices:', error);
      return [];
    }
  }

  /**
   * Debug method to log current device status and help diagnose device selection issues
   */
  async logDeviceStatus(): Promise<void> {
    try {
      console.log('=== Device Status Debug ===');

      const devices = await this.getAudioDevices();
      console.log('Available devices:', devices);

      const currentDeviceId = this.getCurrentDeviceId();
      console.log('Current device ID:', currentDeviceId);

      const defaultDeviceId = await this.getDefaultDeviceId();
      console.log('Default device ID:', defaultDeviceId);

      const currentStream = this.getStream();
      if (currentStream) {
        const tracks = currentStream.getAudioTracks();
        console.log(
          'Current stream tracks:',
          tracks.map((track) => ({
            deviceId: track.getSettings().deviceId,
            label: track.label,
            enabled: track.enabled,
            muted: track.muted,
          }))
        );
      } else {
        console.log('No current stream');
      }

      console.log('=== End Device Status Debug ===');
    } catch (error) {
      console.error('Error logging device status:', error);
    }
  }

  /**
   * Forces VAD reinitialization with the current audio stream
   * This can be useful for debugging device switching issues
   */
  async forceVADReinitialization(): Promise<void> {
    try {
      console.log('Forcing VAD reinitialization');
      this.vadManager.forceReinitialization();
      console.log('VAD reinitialization completed');
    } catch (error) {
      console.error('Error during VAD reinitialization:', error);
      throw error;
    }
  }
}

export default LayercodeClient;
export type { ILayercodeClient, LayercodeClientOptions };
