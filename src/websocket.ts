import {
  ClientMessage,
  ServerMessage,
  ClientAudioMessage,
  ClientTriggerTurnMessage,
  ClientTriggerResponseAudioReplayFinishedMessage,
  ClientVadEventsMessage,
} from './interfaces';
import { base64ToArrayBuffer } from './utils';

export interface WebSocketCallbacks {
  onConnect: (data: { sessionId: string | null }) => void;
  onDisconnect: () => void;
  onError: (error: Error) => void;
  onDataMessage: (message: any) => void;
  onTurnStart: (message: any) => void;
  onResponseAudio: (audioBuffer: ArrayBuffer, turnId: string) => void;
  onResponseText: (message: any) => void;
  onStatusChange: (status: string) => void;
}

export interface WebSocketConfig {
  url: string;
  clientSessionKey: string;
}

export class WebSocketManager {
  private ws: WebSocket | null = null;
  private callbacks: WebSocketCallbacks;
  private config: WebSocketConfig | null = null;
  private status: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected';
  private sessionId: string | null = null;

  constructor(callbacks: WebSocketCallbacks) {
    this.callbacks = callbacks;
  }

  /**
   * Connects to the WebSocket server
   */
  connect(config: WebSocketConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.config = config;
        this._setStatus('connecting');

        // Create WebSocket connection
        this.ws = new WebSocket(
          `${config.url}?${new URLSearchParams({
            client_session_key: config.clientSessionKey,
          })}`
        );

        // Bind event handlers
        this.ws.onmessage = this._handleMessage.bind(this);
        this.ws.onopen = () => {
          console.log('WebSocket connection established');
          this._setStatus('connected');
          this.callbacks.onConnect({ sessionId: this.sessionId });
          resolve();
        };
        this.ws.onclose = () => {
          console.log('WebSocket connection closed');
          this._setStatus('disconnected');
          this.callbacks.onDisconnect();
        };
        this.ws.onerror = (error: Event) => {
          console.error('WebSocket error:', error);
          this._setStatus('error');
          this.callbacks.onError(new Error('WebSocket connection error'));
          reject(new Error('WebSocket connection error'));
        };
      } catch (error) {
        this._setStatus('error');
        reject(error);
      }
    });
  }

  /**
   * Disconnects from the WebSocket server
   */
  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this._setStatus('disconnected');
  }

  /**
   * Sends a message over the WebSocket
   */
  send(message: ClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('WebSocket is not open. Message not sent:', message);
      return;
    }

    const messageString = JSON.stringify(message);
    console.log('sent ws msg:', message);
    this.ws.send(messageString);
  }

  /**
   * Sends audio data
   */
  sendAudio(content: string): void {
    this.send({
      type: 'client.audio',
      content,
    } as ClientAudioMessage);
  }

  /**
   * Sends turn start message
   */
  sendTurnStart(role: 'user' | 'assistant'): void {
    this.send({
      type: 'trigger.turn.start',
      role,
    } as ClientTriggerTurnMessage);
  }

  /**
   * Sends turn end message
   */
  sendTurnEnd(role: 'user' | 'assistant'): void {
    this.send({
      type: 'trigger.turn.end',
      role,
    } as ClientTriggerTurnMessage);
  }

  /**
   * Sends audio replay finished message
   */
  sendAudioReplayFinished(turnId: string): void {
    this.send({
      type: 'trigger.response.audio.replay_finished',
      turn_id: turnId,
      reason: 'completed',
    } as ClientTriggerResponseAudioReplayFinishedMessage);
  }


  /**
   * Sends VAD event
   */
  sendVADEvent(event: 'vad_start' | 'vad_end' | 'vad_model_failed'): void {
    this.send({
      type: 'vad_events',
      event,
    } as ClientVadEventsMessage);
  }

  /**
   * Sends client ready message
   */
  sendClientReady(): void {
    this.send({ type: 'client.ready' } as ClientMessage);
  }

  /**
   * Checks if the WebSocket is connected and ready
   */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Gets the current connection status
   */
  getStatus(): string {
    return this.status;
  }

  /**
   * Gets the current session ID
   */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Sets the session ID
   */
  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  /**
   * Handles incoming WebSocket messages
   */
  private async _handleMessage(event: MessageEvent): Promise<void> {
    try {
      const message: ServerMessage = JSON.parse(event.data);
      if (message.type !== 'response.audio') {
        console.log('received ws msg:', message);
      }

      switch (message.type) {
        case 'turn.start':
          this.callbacks.onTurnStart(message);
          break;

        case 'response.audio':
          // Convert base64 to ArrayBuffer and pass to callback
          const audioBuffer = base64ToArrayBuffer(message.content);
          this.callbacks.onResponseAudio(audioBuffer, message.turn_id);
          break;

        case 'response.text':
          this.callbacks.onResponseText(message);
          break;

        case 'response.data':
          this.callbacks.onDataMessage(message);
          break;

        default:
          const unknownMessage = message as { type: string; [key: string]: any };
          console.warn('Unknown message type received:', unknownMessage.type, message);
          break;
      }
    } catch (error) {
      console.error('Error processing WebSocket message:', error);
      this.callbacks.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Sets the connection status and notifies callback
   */
  private _setStatus(status: 'disconnected' | 'connecting' | 'connected' | 'error'): void {
    this.status = status;
    this.callbacks.onStatusChange(status);
  }

}
