export type LayercodeMessageType =
  // Client → Server WebSocket
  | 'client.audio'
  | 'trigger.turn.start'
  | 'trigger.turn.end'
  | 'trigger.response.audio.replay_finished'
  | 'vad_events'
  | 'client.ready'

  // Server → Client WebSocket
  | 'turn.start'
  | 'response.audio'
  | 'response.text' // Text content for interruption tracking
  | 'response.data' // Webhook event forwarded by server to client
  | 'user.transcript.interim_delta' // Interial partial user transcript text that will updated as confidance in the transcription increases
  | 'user.transcript.delta' // Partial user transcript text as it's transcribed
  | 'user.transcript'; // Final user transcript text at end of user turn

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
  event: 'vad_start' | 'vad_end' | 'vad_model_failed';
}

export interface ClientReadyMessage extends BaseLayercodeMessage {
  type: 'client.ready';
}

export interface ClientTriggerResponseAudioReplayFinishedMessage extends BaseLayercodeMessage {
  type: 'trigger.response.audio.replay_finished';
  reason: 'completed';
  last_delta_id_played?: string;
}

// Layercode Server WebSocket Messages → Client Browser WebSocket Messages
export interface ServerTurnMessage extends BaseLayercodeMessage {
  type: 'turn.start';
  role: 'user' | 'assistant'; // Note assistant role events are not currently implemented
  // turn_id: string; // TODO refactor our agents to allow turn_id to be included here
}

export interface ServerResponseAudioMessage extends BaseLayercodeMessage {
  type: 'response.audio';
  content: string;
  delta_id?: string;
  turn_id: string;
}

export interface ServerResponseTextMessage extends BaseLayercodeMessage {
  type: 'response.text';
  content: string;
  turn_id: string;
}

export interface ServerResponseDataMessage extends BaseLayercodeMessage {
  type: 'response.data';
  content: any;
  turn_id: string;
}

export interface ServerResponseUserTranscriptInterimDelta extends BaseLayercodeMessage {
  type: 'user.transcript.interim_delta';
  content: string;
  turn_id: string;
  delta_counter: number;
}

export interface ServerResponseUserTranscriptDelta extends BaseLayercodeMessage {
  type: 'user.transcript.delta';
  content: string;
  turn_id: string;
  delta_counter: number;
}

export interface ServerResponseUserTranscript extends BaseLayercodeMessage {
  type: 'user.transcript';
  content: string;
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

export type ServerMessage =
  | ServerTurnMessage
  | ServerResponseAudioMessage
  | ServerResponseTextMessage
  | ServerResponseDataMessage
  | ServerResponseUserTranscriptInterimDelta
  | ServerResponseUserTranscriptDelta
  | ServerResponseUserTranscript;

export type ClientMessage = ClientAudioMessage | ClientTriggerTurnMessage | ClientTriggerResponseAudioReplayFinishedMessage | ClientVadEventsMessage | ClientReadyMessage;

// Union type for all possible messages
export type LayercodeMessage = ClientMessage | ServerMessage;
// export type LayercodeMessage = ClientMessage | WebhookMessage | ServerMessage;
