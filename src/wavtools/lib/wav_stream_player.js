import { StreamProcessorSrc } from "./worklets/stream_processor.js";
import { AudioAnalysis } from "./analysis/audio_analysis.js";

/**
 * Plays audio streams received in raw PCM16 chunks from the browser
 * @class
 */
export class WavStreamPlayer {
  /**
   * Creates a new WavStreamPlayer instance
   * @param {{sampleRate?: number}} options
   * @returns {WavStreamPlayer}
   */
  constructor({ finishedPlayingCallback = () => {}, sampleRate = 24000 } = {}) {
    this.scriptSrc = StreamProcessorSrc;
    this.sampleRate = sampleRate;
    this.context = null;
    this.stream = null;
    this.analyser = null;
    this.trackSampleOffsets = {};
    this.interruptedTrackIds = {};
    this.finishedPlayingCallback = finishedPlayingCallback;
    this.isPlaying = false;
  }

  /**
   * Clears interrupted track IDs to prevent memory leaks
   * @param {string[]} [keepTrackIds] - Track IDs to keep in the interrupted list
   */
  clearInterruptedTracks(keepTrackIds = []) {
    if (keepTrackIds.length === 0) {
      this.interruptedTrackIds = {};
    } else {
      const newInterruptedTracks = {};
      for (const trackId of keepTrackIds) {
        if (this.interruptedTrackIds[trackId]) {
          newInterruptedTracks[trackId] = true;
        }
      }
      this.interruptedTrackIds = newInterruptedTracks;
    }
  }

  /**
   * Connects the audio context and enables output to speakers
   * @returns {Promise<true>}
   */
  async connect() {
    this.context = new AudioContext({ sampleRate: this.sampleRate });
    if (this.context.state === "suspended") {
      await this.context.resume();
    }
    try {
      await this.context.audioWorklet.addModule(this.scriptSrc);
    } catch (e) {
      console.error(e);
      throw new Error(`Could not add audioWorklet module: ${this.scriptSrc}`);
    }
    const analyser = this.context.createAnalyser();
    analyser.fftSize = 8192;
    analyser.smoothingTimeConstant = 0.1;
    this.analyser = analyser;
    this.isPlaying = true;
    return true;
  }

  /**
   * Gets the current frequency domain data from the playing track
   * @param {"frequency"|"music"|"voice"} [analysisType]
   * @param {number} [minDecibels] default -100
   * @param {number} [maxDecibels] default -30
   * @returns {import('./analysis/audio_analysis.js').AudioAnalysisOutputType}
   */
  getFrequencies(analysisType = "frequency", minDecibels = -100, maxDecibels = -30) {
    if (!this.analyser) {
      throw new Error("Not connected, please call .connect() first");
    }
    return AudioAnalysis.getFrequencies(this.analyser, this.sampleRate, null, analysisType, minDecibels, maxDecibels);
  }

  /**
   * Gets the real-time amplitude of the audio signal
   * @returns {number} Amplitude value between 0 and 1
   */
  getAmplitude() {
    if (!this.analyser) {
      throw new Error("AnalyserNode is not initialized. Please call connect() first.");
    }

    const bufferLength = this.analyser.fftSize;
    const dataArray = new Uint8Array(bufferLength);
    this.analyser.getByteTimeDomainData(dataArray);

    // Calculate RMS (Root Mean Square) to get amplitude
    let sumSquares = 0;
    for (let i = 0; i < bufferLength; i++) {
      const normalized = (dataArray[i] - 128) / 128; // Normalize between -1 and 1
      sumSquares += normalized * normalized;
    }
    const rms = Math.sqrt(sumSquares / bufferLength);
    return rms;
  }

  /**
   * Starts amplitude monitoring
   * @param {function} callback - Function to call with amplitude value
   */
  startAmplitudeMonitoring(callback) {
    const monitor = () => {
      const amplitude = this.getAmplitude();
      callback(amplitude);
      requestAnimationFrame(monitor);
    };
    monitor();
  }

  /**
   * Starts audio streaming
   * @private
   * @returns {Promise<true>}
   */
  _start() {
    const streamNode = new AudioWorkletNode(this.context, "stream_processor");
    streamNode.connect(this.context.destination);
    streamNode.port.onmessage = (e) => {
      const { event } = e.data;
      if (event === "stop") {
        streamNode.disconnect();
        this.stream = null;
        this.isPlaying = false;
        this.finishedPlayingCallback();
      } else if (event === "offset") {
        const { requestId, trackId, offset } = e.data;
        const currentTime = offset / this.sampleRate;
        this.trackSampleOffsets[requestId] = { trackId, offset, currentTime };
      }
    };
    this.analyser.disconnect();
    streamNode.connect(this.analyser);
    this.stream = streamNode;
    this.isPlaying = true;
    return true;
  }

  /**
   * Adds 16BitPCM data to the currently playing audio stream
   * You can add chunks beyond the current play point and they will be queued for play
   * @param {ArrayBuffer|Int16Array} arrayBuffer
   * @param {string} [trackId]
   * @returns {Int16Array}
   */
  add16BitPCM(arrayBuffer, trackId = "default") {
    if (typeof trackId !== "string") {
      throw new Error(`trackId must be a string`);
    } else if (this.interruptedTrackIds[trackId]) {
      return;
    }
    if (!this.stream) {
      this._start();
    }
    let buffer;
    if (arrayBuffer instanceof Int16Array) {
      buffer = arrayBuffer;
    } else if (arrayBuffer instanceof ArrayBuffer) {
      buffer = new Int16Array(arrayBuffer);
    } else {
      throw new Error(`argument must be Int16Array or ArrayBuffer`);
    }
    this.stream.port.postMessage({ event: "write", buffer, trackId });
    return buffer;
  }

  /**
   * Gets the offset (sample count) of the currently playing stream
   * @param {boolean} [interrupt]
   * @returns {{trackId: string|null, offset: number, currentTime: number}}
   */
  async getTrackSampleOffset(interrupt = false) {
    if (!this.stream) {
      return null;
    }
    const requestId = crypto.randomUUID();
    this.stream.port.postMessage({
      event: interrupt ? "interrupt" : "offset",
      requestId,
    });
    let trackSampleOffset;
    while (!trackSampleOffset) {
      trackSampleOffset = this.trackSampleOffsets[requestId];
      await new Promise((r) => setTimeout(() => r(), 1));
    }
    const { trackId } = trackSampleOffset;
    if (interrupt && trackId) {
      this.interruptedTrackIds[trackId] = true;
    }
    return trackSampleOffset;
  }

  /**
   * Strips the current stream and returns the sample offset of the audio
   * @param {boolean} [interrupt]
   * @returns {{trackId: string|null, offset: number, currentTime: number}}
   */
  async interrupt() {
    return this.getTrackSampleOffset(true);
  }

  /**
   * Pauses audio playback while preserving audio in the buffer
   * @returns {Promise<boolean>}
   */
  async pause() {
    if (!this.context || !this.stream || !this.isPlaying) {
      // Cannot pause if not connected, no stream, or already paused/stopped
      return false;
    }
    
    this.stream.port.postMessage({ event: 'pause' });
    this.isPlaying = false;
    console.log("WavStreamPlayer: Paused via worklet message");
    return true;
  }
  
  /**
   * Resumes audio playback from where it was paused
   * @returns {Promise<boolean>}
   */
  async play() {
    if (!this.context) {
      // Cannot play if not connected
      return false;
    }

    // Ensure the audio context is running, especially if it was auto-suspended by the browser
    if (this.context.state === 'suspended') {
      try {
        await this.context.resume();
        console.log("WavStreamPlayer: AudioContext resumed");
      } catch (err) {
        console.error("Error resuming AudioContext:", err);
        return false;
      }
    }

    if (!this.stream) {
      // If there's no stream (e.g., after a full stop), play won't do anything
      // until add16BitPCM is called again, which calls _start()
      console.log("WavStreamPlayer: No active stream to play. Call add16BitPCM to start a new stream.");
      return false;
    }
    
    if (this.isPlaying) {
      // Already playing
      return true;
    }

    this.stream.port.postMessage({ event: 'play' });
    this.isPlaying = true;
    console.log("WavStreamPlayer: Played via worklet message");
    return true;
  }

  /**
   * Disconnects the audio context and cleans up resources
   * @returns {void}
   */
  disconnect() {
    if (this.stream) {
      this.stream.disconnect();
      this.stream = null;
    }

    if (this.analyser) {
      this.analyser.disconnect();
    }

    if (this.context && this.context.state !== 'closed') {
      this.context.close().catch((err) => console.error("Error closing audio context:", err));
    }
    
    this.isPlaying = false;
  }
}

globalThis.WavStreamPlayer = WavStreamPlayer;
