/* eslint-env browser */
import { WavRecorder, WavStreamPlayer } from './wavtools/index.js';
import { MicVAD } from '@ricky0123/vad-web';
import { base64ToArrayBuffer, arrayBufferToBase64 } from './utils.js';
import {
  LayercodeMessage,
  ClientMessage,
  ServerMessage,
  ClientAudioMessage,
  ClientTriggerTurnMessage,
  ClientTriggerResponseAudioReplayFinishedMessage,
  ServerTurnMessage,
  ServerResponseAudioMessage,
  ServerResponseDataMessage,
} from './interfaces.js';

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
  /** Enable/disable voice activity detector (VAD) which improves turn taking */
  vadEnabled?: boolean;
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
}

/**
 * @class LayercodeClient
 * @classdesc Core client for Layercode audio pipeline that manages audio recording, WebSocket communication, and speech processing.
 */
class LayercodeClient {
  private options: Required<LayercodeClientOptions>;
  private wavRecorder: WavRecorder;
  private wavPlayer: WavStreamPlayer;
  private vad: MicVAD | null;
  private ws: WebSocket | null;
  private AMPLITUDE_MONITORING_SAMPLE_RATE: number;
  private pushToTalkActive: boolean;
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
      vadEnabled: options.vadEnabled || true,
      onConnect: options.onConnect || (() => {}),
      onDisconnect: options.onDisconnect || (() => {}),
      onError: options.onError || (() => {}),
      onDataMessage: options.onDataMessage || (() => {}),
      onUserAmplitudeChange: options.onUserAmplitudeChange || (() => {}),
      onAgentAmplitudeChange: options.onAgentAmplitudeChange || (() => {}),
      onStatusChange: options.onStatusChange || (() => {}),
    };

    this.AMPLITUDE_MONITORING_SAMPLE_RATE = 10;
    this._websocketUrl = 'wss://api.layercode.com/v1/pipelines/websocket';

    this.wavRecorder = new WavRecorder({ sampleRate: 8000 }); // TODO should be set my fetched pipeline config
    this.wavPlayer = new WavStreamPlayer({
      finishedPlayingCallback: this._clientResponseAudioReplayFinished.bind(this),
      sampleRate: 16000, // TODO should be set my fetched pipeline config
    });
    this.vad = null;
    if (this.options.vadEnabled) {
      MicVAD.new({
        stream: this.wavRecorder.getStream() || undefined,
        model: 'v5',
        // baseAssetPath: '/', // Use if bundling model locally
        // onnxWASMBasePath: '/', // Use if bundling model locally
        positiveSpeechThreshold: 0.4,
        negativeSpeechThreshold: 0.4,
        minSpeechFrames: 15,
        preSpeechPadFrames: 30,
        onSpeechStart: () => {
          console.log('onSpeechStart');
        },
        onSpeechEnd: (arr) => {
          console.log('onSpeechEnd');
        },
      })
        .then((vad) => {
          this.vad = vad;
          this.vad.start();
          console.log('VAD started');
        })
        .catch((error) => {
          console.error('Error initializing VAD:', error);
        });
    }

    this.ws = null;
    this.status = 'disconnected';
    this.userAudioAmplitude = 0;
    this.agentAudioAmplitude = 0;
    this.sessionId = options.sessionId || null;
    this.pushToTalkActive = false;

    // Bind event handlers
    this._handleWebSocketMessage = this._handleWebSocketMessage.bind(this);
    this._handleDataAvailable = this._handleDataAvailable.bind(this);
  }

  /**
   * Updates the connection status and triggers the callback
   * @param {string} status - New status value
   * @private
   */
  private _setStatus(status: string): void {
    this.status = status;
    this.options.onStatusChange(status);
  }

  /**
   * Handles when agent audio finishes playing
   * @private
   */
  private _clientResponseAudioReplayFinished(): void {
    console.log('clientResponseAudioReplayFinished');
    this._wsSend({
      type: 'trigger.response.audio.replay_finished',
      reason: 'completed',
    } as ClientTriggerResponseAudioReplayFinishedMessage);
  }

  private async _clientInterruptAssistantReplay(): Promise<void> {
    await this.wavPlayer.interrupt();
    // TODO: Use in voice pipeline to know how much of the audio has been played and how much to truncate transcript
    // this._wsSend({
    //   type: 'trigger.response.audio.replay_finished',
    //   reason: 'interrupted',
    //   delta_id: 'TODO'
    // });
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
   * @private
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
          // if (message.role === 'user' && !this.pushToTalkActive) {
          if (message.role === 'user') {
            // Interrupt any playing assistant audio if this is a turn trigged by the server (and not push to talk, which will have already called interrupt)
            console.log('interrupting assistant audio, as user turn has started and pushToTalkActive is false');
            await this._clientInterruptAssistantReplay();
          }
          break;

        case 'response.audio':
          const audioBuffer = base64ToArrayBuffer(message.content);
          this.wavPlayer.add16BitPCM(audioBuffer, message.turn_id);
          break;

        // case 'response.end':
        //   console.log('received response.end');
        //   break;

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
   * @private
   */
  private _handleDataAvailable(data: { mono: Int16Array<ArrayBufferLike> }): void {
    try {
      const base64 = arrayBufferToBase64(data.mono);
      this._wsSend({
        type: 'client.audio',
        content: base64,
      } as ClientAudioMessage);
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

  /**
   * Sets up amplitude monitoring for a given audio source.
   * @param {WavRecorder | WavStreamPlayer} source - The audio source (recorder or player).
   * @param {(amplitude: number) => void} callback - The callback function to invoke on amplitude change.
   * @param {(amplitude: number) => void} updateInternalState - Function to update the internal amplitude state.
   * @private
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

      // Get session key from server
      let authorizeSessionRequestBody = {
        pipeline_id: this.options.pipelineId,
        metadata: this.options.metadata,
      } as { pipeline_id: string; metadata: Record<string, any>; session_id?: string };
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
      // Bind the websocket message callbacks
      this.ws.onmessage = this._handleWebSocketMessage;
      this.ws.onopen = () => {
        console.log('WebSocket connection established');
        this._setStatus('connected');
        this.options.onConnect({ sessionId: this.sessionId });
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
      await this.wavRecorder.record(this._handleDataAvailable);
      // Set up microphone amplitude monitoring
      this._setupAmplitudeMonitoring(this.wavRecorder, this.options.onUserAmplitudeChange, (amp) => (this.userAudioAmplitude = amp));

      // Initialize audio player
      await this.wavPlayer.connect();
      // Set up audio player amplitude monitoring
      this._setupAmplitudeMonitoring(this.wavPlayer, this.options.onAgentAmplitudeChange, (amp) => (this.agentAudioAmplitude = amp));
    } catch (error) {
      console.error('Error connecting to Layercode pipeline:', error);
      this._setStatus('error');
      this.options.onError(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    this.wavRecorder.quit();
    this.wavPlayer.disconnect();
    this.ws?.close();
  }

  /**
   * Gets the microphone MediaStream used by this client
   * @returns {MediaStream|null} The microphone stream or null if not initialized
   */
  getStream(): MediaStream | null {
    return this.wavRecorder.getStream();
  }
}

export default LayercodeClient;
