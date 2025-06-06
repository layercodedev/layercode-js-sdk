export class WavRecorder {
  constructor(options?: { sampleRate?: number; outputToSpeakers?: boolean; debug?: boolean });
  begin(deviceId?: string): Promise<true>;
  record(chunkProcessor?: (data: { mono: Int16Array; raw: Int16Array }) => any, chunkSize?: number): Promise<true>;
  pause(): Promise<true>;
  end(): Promise<import('./lib/wav_packer.js').WavPackerAudioType>;
  clear(): Promise<true>;
  read(): Promise<{ meanValues: Float32Array; channels: Array<Float32Array> }>;
  save(force?: boolean): Promise<import('./lib/wav_packer.js').WavPackerAudioType>;
  quit(): Promise<true>;
  listDevices(): Promise<Array<MediaDeviceInfo & { default: boolean }>>;
  requestPermission(): Promise<true>;
  listenForDeviceChange(callback: ((devices: Array<MediaDeviceInfo & { default: boolean }>) => void) | null): true;
  getFrequencies(analysisType?: 'frequency' | 'music' | 'voice', minDecibels?: number, maxDecibels?: number): import('./lib/analysis/audio_analysis.js').AudioAnalysisOutputType;
  getAmplitude(): number;
  startAmplitudeMonitoring(callback: (amplitude: number) => void): void;
  getStatus(): 'ended' | 'paused' | 'recording';
  getSampleRate(): number;
  getStream(): MediaStream | null;
}

export class WavStreamPlayer {
  constructor(options?: { finishedPlayingCallback?: () => void; sampleRate?: number });
  connect(): Promise<true>;
  disconnect(): void;
  pause(): Promise<true>;
  play(): Promise<true>;
  add16BitPCM(buffer: ArrayBuffer | Int16Array, trackId?: string): Int16Array;
  interrupt(): Promise<{
    trackId: string | null;
    offset: number;
    currentTime: number;
  }>;
  getFrequencies(analysisType?: 'frequency' | 'music' | 'voice', minDecibels?: number, maxDecibels?: number): import('./lib/analysis/audio_analysis.js').AudioAnalysisOutputType;
  getAmplitude(): number;
  startAmplitudeMonitoring(callback: (amplitude: number) => void): void;
  getTrackSampleOffset(interrupt?: boolean): Promise<{ trackId: string | null; offset: number; currentTime: number } | null>;
  clearInterruptedTracks(keepTrackIds?: string[]): void;
  isPlaying: boolean;
}

export class WavPacker {
  // Add methods as needed
}

export class AudioAnalysis {
  // Add methods as needed
}
