/* eslint-env browser */
import { WavRecorder, WavStreamPlayer } from './wavtools/';
import { arrayBufferToBase64 } from './utils';
import { VADManager, VADConfig } from './vad-manager';
import { WebSocketManager } from './websocket';
import { DeviceManager } from './device-manager';

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

interface ILayercodeClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  triggerUserTurnStarted(): Promise<void>;
  triggerUserTurnFinished(): Promise<void>;
  getStream(): MediaStream | null;
  setInputDevice(deviceId: string): Promise<void>;
  forceVADReinitialization(): Promise<void>;
  switchToNextDevice(): Promise<void>;
  refreshCurrentDeviceId(): void;
  reinitializeVAD(): Promise<void>;
  restartAudioRecording(): Promise<void>;
  readonly status: string;
  readonly userAudioAmplitude: number;
  readonly agentAudioAmplitude: number;
  readonly sessionId: string | null;
  readonly deviceManager: DeviceManager;
}

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

class LayercodeClient implements ILayercodeClient {
  private options: Required<LayercodeClientOptions>;
  private wavRecorder: WavRecorder;
  private wavPlayer: WavStreamPlayer;
  private vadManager: VADManager;
  private websocketManager: WebSocketManager;
  readonly deviceManager: DeviceManager;
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

    // Initialize Device manager
    this.deviceManager = new DeviceManager(
      this.wavRecorder,
      {
        onDeviceChange: (devices) => {
          // Handle device changes if needed
          console.log('Device list updated:', devices);
        },
        onDeviceError: (error) => {
          this.options.onError(error);
        },
        onDeviceDisconnected: (deviceId) => {
          console.log(`Audio device disconnected: ${deviceId}`);
          // You can add custom handling here, such as showing a notification to the user
        },
        onDeviceSwitched: async (fromDeviceId, toDeviceId) => {
          console.log(`Audio device automatically switched from ${fromDeviceId} to ${toDeviceId}`);
          // Reinitialize VAD and restart recording after device switch
          await this._reinitializeVADAfterDeviceSwitch();
          await this._restartAudioRecordingAfterDeviceSwitch();
        },
      },
      {
        autoSwitchOnDisconnect: true,
        listenForDeviceChanges: true,
      }
    );

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
      onVADFailure: (_error: any) => {
        this.websocketManager.sendVADEvent('vad_model_failed');
      },
      onStatusChange: (_status: string) => {
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
    const currentStream = this.deviceManager.getCurrentStream();
    this.vadManager.initialize(this.vadConfig || null, currentStream, this.pushToTalkEnabled);
  }

  /**
   * Reinitializes VAD after a device switch to ensure it uses the new audio stream
   */
  private async _reinitializeVADAfterDeviceSwitch(): Promise<void> {
    try {
      console.log('Reinitializing VAD after device switch...');

      // Get the new audio stream from the device manager
      const newStream = this.deviceManager.getCurrentStream();
      if (!newStream) {
        console.warn('No audio stream available for VAD reinitialization');
        return;
      }

      // Reinitialize VAD with the new stream
      if (this.vadManager.isVADEnabled()) {
        console.log('Reinitializing VAD with new audio stream');
        this.vadManager.reinitialize(newStream);
      } else {
        console.log('VAD is not enabled, skipping reinitialization');
      }

      console.log('VAD reinitialization completed successfully');
    } catch (error) {
      console.error('Error reinitializing VAD after device switch:', error);
      this.options.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Restarts audio recording after a device switch to ensure audio is captured from the new device
   */
  private async _restartAudioRecordingAfterDeviceSwitch(): Promise<void> {
    try {
      console.log('Restarting audio recording after device switch...');

      // Get the new audio stream from the device manager
      const newStream = this.deviceManager.getCurrentStream();
      if (!newStream) {
        console.warn('No audio stream available for audio recording restart');
        return;
      }

      // Restart recording with the new device
      await this.wavRecorder.record(this._handleDataAvailable, 1638);

      // Re-setup amplitude monitoring with the new stream
      this._setupAmplitudeMonitoring(this.wavRecorder, this.options.onUserAmplitudeChange, (amp) => (this.userAudioAmplitude = amp));

      console.log('Audio recording restart completed successfully');
    } catch (error) {
      console.error('Error restarting audio recording after device switch:', error);
      this.options.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private _setStatus(status: string): void {
    this.status = status;
    this.options.onStatusChange(status);
  }

  private _clientResponseAudioReplayFinished(): void {
    console.log('clientResponseAudioReplayFinished');
    this.websocketManager.sendAudioReplayFinished(this.currentTurnId || '');
  }

  private async _clientInterruptAssistantReplay(): Promise<void> {
    await this.wavPlayer.interrupt();
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
      const initialStream = this.deviceManager.getCurrentStream();
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

    // Clean up device manager
    this.deviceManager.destroy();

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

  async setInputDevice(deviceId: string): Promise<void> {
    try {
      // Use DeviceManager to switch devices
      await this.deviceManager.setInputDevice(deviceId);

      // Restart recording with the new device
      await this.wavRecorder.record(this._handleDataAvailable, 1638);
      this._setupAmplitudeMonitoring(this.wavRecorder, this.options.onUserAmplitudeChange, (amp) => (this.userAudioAmplitude = amp));

      // Reinitialize VAD with the new audio stream if VAD is enabled
      if (this.vadManager.isVADEnabled()) {
        console.log('Reinitializing VAD with new audio stream');
        const newStream = this.deviceManager.getCurrentStream();
        this.vadManager.reinitialize(newStream);
      }

      console.log(`Successfully switched to input device: ${deviceId}`);
    } catch (error) {
      console.error(`Failed to switch to input device ${deviceId}:`, error);
      throw new Error(`Failed to switch to input device: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

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

  /**
   * Manually switches to the next available audio input device
   */
  async switchToNextDevice(): Promise<void> {
    try {
      await this.deviceManager.switchToNextDevice();
    } catch (error) {
      console.error('Error switching to next device:', error);
      throw error;
    }
  }

  /**
   * Refreshes the current device ID from the current audio stream
   */
  refreshCurrentDeviceId(): void {
    this.deviceManager.updateCurrentDeviceId();
  }

  /**
   * Manually reinitializes VAD with the current audio stream
   * Useful for debugging or when VAD needs to be refreshed after device changes
   */
  async reinitializeVAD(): Promise<void> {
    try {
      console.log('Manually reinitializing VAD...');
      const currentStream = this.deviceManager.getCurrentStream();
      if (currentStream && this.vadManager.isVADEnabled()) {
        this.vadManager.reinitialize(currentStream);
        console.log('VAD reinitialization completed successfully');
      } else {
        console.log('VAD reinitialization skipped - no stream or VAD not enabled');
      }
    } catch (error) {
      console.error('Error reinitializing VAD:', error);
      throw error;
    }
  }

  /**
   * Manually restarts audio recording with the current audio stream
   * Useful for debugging or when audio recording needs to be refreshed after device changes
   */
  async restartAudioRecording(): Promise<void> {
    try {
      console.log('Manually restarting audio recording...');
      const currentStream = this.deviceManager.getCurrentStream();
      if (currentStream) {
        await this.wavRecorder.record(this._handleDataAvailable, 1638);
        this._setupAmplitudeMonitoring(this.wavRecorder, this.options.onUserAmplitudeChange, (amp) => (this.userAudioAmplitude = amp));
        console.log('Audio recording restart completed successfully');
      } else {
        console.log('Audio recording restart skipped - no stream available');
      }
    } catch (error) {
      console.error('Error restarting audio recording:', error);
      throw error;
    }
  }
}

export default LayercodeClient;
export type { ILayercodeClient, LayercodeClientOptions };
