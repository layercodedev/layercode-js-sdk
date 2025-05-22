export type LayercodeMessageType =
  // Client → Server WebSocket
  | 'client.audio'
  | 'trigger.turn.start'
  | 'trigger.turn.end'
  | 'trigger.response.audio.replay_finished'
  | 'vad_events'

  // Server → Client WebSocket
  | 'turn.start' // Not currently implemented
  | 'turn.end' // Not currently implemented
  | 'response.audio'
  | 'response.data'; // Webhook event forwarded by server to client

// // Webhook → Server SSE
// | 'response.tts'
// | 'response.data'
// | 'response.end' // Also sent from server to client

// Base interface for all messages
export interface BaseLayercodeMessage {
  type: LayercodeMessageType;
  event_id?: string;
}

// Client Browser → Layercode Server WebSocket Messages
export interface ClientAudioMessage extends BaseLayercodeMessage {
  type: 'client.audio';
  content: string;
}

export interface ClientTriggerTurnMessage extends BaseLayercodeMessage {
  type: 'trigger.turn.start' | 'trigger.turn.end';
  role: 'user';
}

export interface ClientVadEventsMessage extends BaseLayercodeMessage {
  type: 'vad_events';
  event: 'vad_start' | 'vad_end';
}

export interface ClientTriggerResponseAudioReplayFinishedMessage extends BaseLayercodeMessage {
  type: 'trigger.response.audio.replay_finished';
  reason: 'completed' | 'interrupted';
  last_delta_id_played?: string;
}

// Layercode Server WebSocket Messages → Client Browser WebSocket Messages
export interface ServerTurnMessage extends BaseLayercodeMessage {
  type: 'turn.start' | 'turn.end';
  role: 'user' | 'assistant'; // Note assistant role events are not currently implemented
  // turn_id: string; // TODO refactor our pipeines to allow turn_id to be included here
}

export interface ServerResponseAudioMessage extends BaseLayercodeMessage {
  type: 'response.audio';
  content: string;
  delta_id?: string;
  turn_id: string;
}

export interface ServerResponseDataMessage extends BaseLayercodeMessage {
  type: 'response.data';
  content: any;
  turn_id: string;
}

// // Webhook Response SSE Messages → Layercode Server
// export interface WebhookResponseTTSMessage extends BaseLayercodeMessage {
//   type: 'response.tts';
//   content: string;
//   turn_id: string;
// }

// export interface WebhookResponseDataMessage extends BaseLayercodeMessage {
//   type: 'response.data';
//   content: any;
//   turn_id: string;
// }

// export interface ResponseEndMessage extends BaseLayercodeMessage {
//   type: 'response.end';
//   turn_id: string;
// }

// Create a discriminated union to differentiate between webhook and server messages
// export type WebhookMessage = WebhookResponseTTSMessage | WebhookResponseDataMessage | ResponseEndMessage;

export type ServerMessage = ServerTurnMessage | ServerResponseAudioMessage | ServerResponseDataMessage;

export type ClientMessage = ClientAudioMessage | ClientTriggerTurnMessage | ClientTriggerResponseAudioReplayFinishedMessage | ClientVadEventsMessage;

// Union type for all possible messages
export type LayercodeMessage = ClientMessage | ServerMessage;
// export type LayercodeMessage = ClientMessage | WebhookMessage | ServerMessage;
