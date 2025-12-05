import { AudioProcessorSrc } from './worklets/audio_processor.js';
import { AudioAnalysis } from './analysis/audio_analysis.js';
import { WavPacker } from './wav_packer.js';

/**
 * Decodes audio into a wav file
 * @typedef {Object} DecodedAudioType
 * @property {Blob} blob
 * @property {string} url
 * @property {Float32Array} values
 * @property {AudioBuffer} audioBuffer
 */

/**
 * Records live stream of user audio as PCM16 "audio/wav" data
 * @class
 */
export class WavRecorder {
  /**
   * Create a new WavRecorder instance
   * @param {{sampleRate?: number, outputToSpeakers?: boolean, debug?: boolean}} [options]
   * @returns {WavRecorder}
   */
  constructor({ sampleRate = 24000, outputToSpeakers = false, debug = false } = {}) {
    // Script source
    this.scriptSrc = AudioProcessorSrc;
    // Config
    this.sampleRate = sampleRate;
    this.outputToSpeakers = outputToSpeakers;
    this.debug = !!debug;
    this._deviceChangeCallback = null;
    this._devices = [];
    // State variables
    this.stream = null;
    this.audioContext = null;
    this.processor = null;
    this.source = null;
    this.node = null;
    this.analyser = null;
    this.recording = false;
    this.contextSampleRate = sampleRate;
    // Track whether we've already obtained microphone permission
    // This avoids redundant getUserMedia calls which are expensive on iOS Safari
    this._hasPermission = false;
    // Promise used to dedupe concurrent requestPermission() calls
    this._permissionPromise = null;
    // Event handling with AudioWorklet
    this._lastEventId = 0;
    this.eventReceipts = {};
    this.eventTimeout = 5000;
    // Process chunks of audio
    this._chunkProcessor = () => {};
    this._chunkProcessorSize = void 0;
    this._chunkProcessorBuffer = {
      raw: new ArrayBuffer(0),
      mono: new ArrayBuffer(0),
    };
    this.amplitudeMonitorRaf = void 0;
  }

  /**
   * Decodes audio data from multiple formats to a Blob, url, Float32Array and AudioBuffer
   * @param {Blob|Float32Array|Int16Array|ArrayBuffer|number[]} audioData
   * @param {number} sampleRate
   * @param {number} fromSampleRate
   * @returns {Promise<DecodedAudioType>}
   */
  static async decode(audioData, sampleRate = 24000, fromSampleRate = -1) {
    const context = new AudioContext({ sampleRate });
    let arrayBuffer;
    let blob;
    if (audioData instanceof Blob) {
      if (fromSampleRate !== -1) {
        throw new Error(`Can not specify "fromSampleRate" when reading from Blob`);
      }
      blob = audioData;
      arrayBuffer = await blob.arrayBuffer();
    } else if (audioData instanceof ArrayBuffer) {
      if (fromSampleRate !== -1) {
        throw new Error(`Can not specify "fromSampleRate" when reading from ArrayBuffer`);
      }
      arrayBuffer = audioData;
      blob = new Blob([arrayBuffer], { type: 'audio/wav' });
    } else {
      let float32Array;
      let data;
      if (audioData instanceof Int16Array) {
        data = audioData;
        float32Array = new Float32Array(audioData.length);
        for (let i = 0; i < audioData.length; i++) {
          float32Array[i] = audioData[i] / 0x8000;
        }
      } else if (audioData instanceof Float32Array) {
        float32Array = audioData;
      } else if (audioData instanceof Array) {
        float32Array = new Float32Array(audioData);
      } else {
        throw new Error(`"audioData" must be one of: Blob, Float32Arrray, Int16Array, ArrayBuffer, Array<number>`);
      }
      if (fromSampleRate === -1) {
        throw new Error(`Must specify "fromSampleRate" when reading from Float32Array, In16Array or Array`);
      } else if (fromSampleRate < 3000) {
        throw new Error(`Minimum "fromSampleRate" is 3000 (3kHz)`);
      }
      if (!data) {
        data = WavPacker.floatTo16BitPCM(float32Array);
      }
      const audio = {
        bitsPerSample: 16,
        channels: [float32Array],
        data,
      };
      const packer = new WavPacker();
      const result = packer.pack(fromSampleRate, audio);
      blob = result.blob;
      arrayBuffer = await blob.arrayBuffer();
    }
    const audioBuffer = await context.decodeAudioData(arrayBuffer);
    const values = audioBuffer.getChannelData(0);
    const url = URL.createObjectURL(blob);
    return {
      blob,
      url,
      values,
      audioBuffer,
    };
  }

  /**
   * Logs data in debug mode
   * @param {...any} args
   * @returns {true}
   */
  log(...args) {
    if (this.debug) {
      // eslint-disable-next-line no-console
      console.log(...args);
    }
    return true;
  }

  /**
   * Retrieves the current sampleRate for the recorder
   * @returns {number}
   */
  getSampleRate() {
    return this.sampleRate;
  }

  /**
   * Get the MediaStream instance
   * @returns {MediaStream|null} The audio stream or null if not initialized
   */
  getStream() {
    return this.stream;
  }

  /**
   * Retrieves the current status of the recording
   * @returns {"ended"|"paused"|"recording"}
   */
  getStatus() {
    if (!this.processor) {
      return 'ended';
    } else if (!this.recording) {
      return 'paused';
    } else {
      return 'recording';
    }
  }

  /**
   * Sends an event to the AudioWorklet
   * @private
   * @param {string} name
   * @param {{[key: string]: any}} data
   * @param {AudioWorkletNode} [_processor]
   * @returns {Promise<{[key: string]: any}>}
   */
  async _event(name, data = {}, _processor = null) {
    _processor = _processor || this.processor;
    if (!_processor) {
      throw new Error('Can not send events without recording first');
    }
    const message = {
      event: name,
      id: this._lastEventId++,
      data,
    };
    _processor.port.postMessage(message);
    const t0 = new Date().valueOf();
    while (!this.eventReceipts[message.id]) {
      if (new Date().valueOf() - t0 > this.eventTimeout) {
        throw new Error(`Timeout waiting for "${name}" event`);
      }
      await new Promise((res) => setTimeout(() => res(true), 1));
    }
    const payload = this.eventReceipts[message.id];
    delete this.eventReceipts[message.id];
    return payload;
  }

  /**
   * Sets device change callback, remove if callback provided is `null`
   * @param {(Array<MediaDeviceInfo & {default: boolean}>): void|null} callback
   * @returns {true}
   */
  listenForDeviceChange(callback) {
    if (callback === null && this._deviceChangeCallback) {
      navigator.mediaDevices.removeEventListener('devicechange', this._deviceChangeCallback);
      this._deviceChangeCallback = null;
    } else if (callback !== null) {
      // Basically a debounce; we only want this called once when devices change
      // And we only want the most recent callback() to be executed
      // if a few are operating at the same time
      let lastId = 0;
      let lastDevices = [];
      const serializeDevices = (devices) =>
        devices
          .map((d) => d.deviceId)
          .sort()
          .join(',');
      const cb = async () => {
        let id = ++lastId;
        const devices = await this.listDevices({ requestPermission: false });
        if (id === lastId) {
          if (serializeDevices(lastDevices) !== serializeDevices(devices)) {
            lastDevices = devices;
            callback(devices.slice());
          }
        }
      };
      navigator.mediaDevices.addEventListener('devicechange', cb);
      cb();
      this._deviceChangeCallback = cb;
    }
    return true;
  }

  /**
   * Manually request permission to use the microphone
   * Skips if permission has already been granted to avoid expensive redundant getUserMedia calls.
   * Dedupes concurrent calls to prevent multiple getUserMedia requests.
   * @returns {Promise<true>}
   */
  async requestPermission() {
    // Skip if we already have permission - each getUserMedia is expensive on iOS Safari
    if (this._hasPermission) {
      return true;
    }
    // Dedupe concurrent calls: if a permission request is already in flight, wait for it
    if (this._permissionPromise) {
      return this._permissionPromise;
    }

    console.log('ensureUserMediaAccess');
    this._permissionPromise = (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });
        // Stop the tracks immediately after getting permission
        stream.getTracks().forEach((track) => track.stop());
        this._hasPermission = true;
        return true;
      } catch (fallbackError) {
        console.error('getUserMedia failed:', fallbackError.name, fallbackError.message);
        throw fallbackError;
      } finally {
        this._permissionPromise = null;
      }
    })();

    return this._permissionPromise;
  }

  /**
   * List all eligible devices for recording.
   *
   * By default this will *not* request mic permission; labels may be empty until
   * the user has granted permission via begin()/getUserMedia.
   * Pass { requestPermission: true } to explicitly trigger a permission prompt.
   *
   * @param {{ requestPermission?: boolean }} [options]
   * @returns {Promise<Array<MediaDeviceInfo & {default: boolean}>>}
   */
  async listDevices({ requestPermission = false } = {}) {
    if (!navigator.mediaDevices || !('enumerateDevices' in navigator.mediaDevices)) {
      throw new Error('Could not request user devices');
    }
    if (requestPermission) {
      await this.requestPermission();
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioDevices = devices.filter((device) => device.kind === 'audioinput');
    const defaultDeviceIndex = audioDevices.findIndex((device) => device.deviceId === 'default');
    const deviceList = [];
    if (defaultDeviceIndex !== -1) {
      let defaultDevice = audioDevices.splice(defaultDeviceIndex, 1)[0];
      let existingIndex = audioDevices.findIndex((device) => device.groupId === defaultDevice.groupId);
      if (existingIndex !== -1) {
        defaultDevice = audioDevices.splice(existingIndex, 1)[0];
      }
      defaultDevice.default = true;
      deviceList.push(defaultDevice);
    } else if (audioDevices.length) {
      const fallbackDefault = audioDevices.shift();
      fallbackDefault.default = true;
      deviceList.push(fallbackDefault);
    }
    return deviceList.concat(audioDevices);
  }

  /**
   * Begins a recording session and requests microphone permissions if not already granted
   * Microphone recording indicator will appear on browser tab but status will be "paused"
   * @param {string} [deviceId] if no device provided, default device will be used
   * @returns {Promise<true>}
   */
  async begin(deviceId) {
    if (this.processor) {
      throw new Error(`Already connected: please call .end() to start a new session`);
    }

    if (!navigator.mediaDevices || !('getUserMedia' in navigator.mediaDevices)) {
      throw new Error('Could not request user media');
    }
    try {
      // Use sensible getUserMedia audio options to improve voice quality
      const config = {
        audio: {
          channelCount: 1,
          echoCancellation: true,
          autoGainControl: true,
          noiseSuppression: true,
        },
      };
      if (deviceId) {
        config.audio.deviceId = { exact: deviceId };
      }
      this.stream = await navigator.mediaDevices.getUserMedia(config);
      // Mark permission as granted so requestPermission() can skip expensive redundant getUserMedia calls
      this._hasPermission = true;
    } catch (err) {
      throw err;
    }

    const createContext = (rate) => {
      try {
        return rate ? new AudioContext({ sampleRate: rate }) : new AudioContext();
      } catch (error) {
        console.warn('Failed to create AudioContext with sampleRate', rate, error);
        return null;
      }
    };

    let context = createContext(this.sampleRate);
    if (!context) {
      context = createContext();
    }
    if (!context) {
      throw new Error('Could not create AudioContext');
    }

    let source;
    try {
      source = context.createMediaStreamSource(this.stream);
    } catch (error) {
      await context.close().catch(() => {});
      context = createContext();
      if (!context) {
        throw error;
      }
      source = context.createMediaStreamSource(this.stream);
    }

    this.contextSampleRate = context.sampleRate;
    // Load and execute the module script.
    try {
      await context.audioWorklet.addModule(this.scriptSrc);
    } catch (e) {
      console.error(e);
      throw new Error(`Could not add audioWorklet module: ${this.scriptSrc}`);
    }
    const processor = new AudioWorkletNode(context, 'audio_processor');
    processor.port.onmessage = (e) => {
      const { event, id, data } = e.data;
      if (event === 'receipt') {
        this.eventReceipts[id] = data;
      } else if (event === 'chunk') {
        if (this._chunkProcessorSize) {
          const buffer = this._chunkProcessorBuffer;
          this._chunkProcessorBuffer = {
            raw: WavPacker.mergeBuffers(buffer.raw, data.raw),
            mono: WavPacker.mergeBuffers(buffer.mono, data.mono),
          };
          if (this._chunkProcessorBuffer.mono.byteLength >= this._chunkProcessorSize) {
            this._chunkProcessor(this._chunkProcessorBuffer);
            this._chunkProcessorBuffer = {
              raw: new ArrayBuffer(0),
              mono: new ArrayBuffer(0),
            };
          }
        } else {
          this._chunkProcessor(data);
        }
      }
    };

    processor.port.postMessage({
      event: 'configure',
      data: {
        inputSampleRate: this.contextSampleRate,
        targetSampleRate: this.sampleRate,
      },
    });

    const node = source.connect(processor);
    const analyser = context.createAnalyser();
    analyser.fftSize = 8192;
    analyser.smoothingTimeConstant = 0.1;
    node.connect(analyser);
    if (this.outputToSpeakers) {
      // eslint-disable-next-line no-console
      console.warn('Warning: Output to speakers may affect sound quality,\n' + 'especially due to system audio feedback preventative measures.\n' + 'use only for debugging');
      analyser.connect(context.destination);
    }

    if (context.state === 'suspended') {
      try {
        await context.resume();
      } catch (resumeError) {
        console.warn('AudioContext resume failed', resumeError);
      }
    }

    this.audioContext = context;
    this.source = source;
    this.node = node;
    this.analyser = analyser;
    this.processor = processor;
    return true;
  }

  /**
   * Gets the current frequency domain data from the recording track
   * @param {"frequency"|"music"|"voice"} [analysisType]
   * @param {number} [minDecibels] default -100
   * @param {number} [maxDecibels] default -30
   * @returns {import('./analysis/audio_analysis.js').AudioAnalysisOutputType}
   */
  getFrequencies(analysisType = 'frequency', minDecibels = -100, maxDecibels = -30) {
    if (!this.processor) {
      throw new Error('Session ended: please call .begin() first');
    }
    return AudioAnalysis.getFrequencies(this.analyser, this.sampleRate, null, analysisType, minDecibels, maxDecibels);
  }

  /**
   * Gets the real-time amplitude of the audio signal
   * @returns {number} Amplitude value between 0 and 1
   */
  getAmplitude() {
    if (!this.analyser) {
      throw new Error('AnalyserNode is not initialized. Please call connect() first.');
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
    this.stopAmplitudeMonitoring();
    const monitor = () => {
      const amplitude = this.getAmplitude();
      callback(amplitude);
      this.amplitudeMonitorRaf = requestAnimationFrame(monitor);
    };
    monitor();
  }

  stopAmplitudeMonitoring() {
    if (this.amplitudeMonitorRaf !== void 0) {
      cancelAnimationFrame(this.amplitudeMonitorRaf);
      this.amplitudeMonitorRaf = void 0;
    }
  }

  /**
   * Pauses the recording
   * Keeps microphone stream open but halts storage of audio
   * @returns {Promise<true>}
   */
  async pause() {
    if (!this.processor) {
      throw new Error('Session ended: please call .begin() first');
    } else if (!this.recording) {
      throw new Error('Already paused: please call .record() first');
    }
    if (this._chunkProcessorBuffer.raw.byteLength) {
      this._chunkProcessor(this._chunkProcessorBuffer);
    }
    this.log('Pausing ...');
    await this._event('stop');
    this.recording = false;
    return true;
  }

  /**
   * Start recording stream and storing to memory from the connected audio source
   * @param {(data: { mono: Int16Array; raw: Int16Array }) => any} [chunkProcessor]
   * @param {number} [chunkSize] chunkProcessor will not be triggered until this size threshold met in mono audio
   * @returns {Promise<true>}
   */
  async record(chunkProcessor = () => {}, chunkSize = 8192) {
    if (!this.processor) {
      throw new Error('Session ended: please call .begin() first');
    } else if (this.recording) {
      throw new Error('Already recording: please call .pause() first');
    } else if (typeof chunkProcessor !== 'function') {
      throw new Error(`chunkProcessor must be a function`);
    }
    this._chunkProcessor = chunkProcessor;
    this._chunkProcessorSize = chunkSize;
    this._chunkProcessorBuffer = {
      raw: new ArrayBuffer(0),
      mono: new ArrayBuffer(0),
    };
    this.log('Recording ...');
    await this._event('start');
    this.recording = true;
    return true;
  }

  /**
   * Clears the audio buffer, empties stored recording
   * @returns {Promise<true>}
   */
  async clear() {
    if (!this.processor) {
      throw new Error('Session ended: please call .begin() first');
    }
    await this._event('clear');
    return true;
  }

  /**
   * Reads the current audio stream data
   * @returns {Promise<{meanValues: Float32Array, channels: Array<Float32Array>}>}
   */
  async read() {
    if (!this.processor) {
      throw new Error('Session ended: please call .begin() first');
    }
    this.log('Reading ...');
    const result = await this._event('read');
    return result;
  }

  /**
   * Saves the current audio stream to a file
   * @param {boolean} [force] Force saving while still recording
   * @returns {Promise<import('./wav_packer.js').WavPackerAudioType>}
   */
  async save(force = false) {
    if (!this.processor) {
      throw new Error('Session ended: please call .begin() first');
    }
    if (!force && this.recording) {
      throw new Error('Currently recording: please call .pause() first, or call .save(true) to force');
    }
    this.log('Exporting ...');
    const exportData = await this._event('export');
    const packer = new WavPacker();
    const result = packer.pack(this.sampleRate, exportData.audio);
    return result;
  }

  /**
   * Ends the current recording session and saves the result
   * @returns {Promise<import('./wav_packer.js').WavPackerAudioType>}
   */
  async end() {
    if (!this.processor) {
      throw new Error('Session ended: please call .begin() first');
    }

    const _processor = this.processor;

    this.log('Stopping ...');
    await this._event('stop');
    this.recording = false;
    const tracks = this.stream.getTracks();
    tracks.forEach((track) => track.stop());

    this.log('Exporting ...');
    const exportData = await this._event('export', {}, _processor);

    this.processor.disconnect();
    this.source.disconnect();
    this.node.disconnect();
    this.analyser.disconnect();
    this.stream = null;
    this.processor = null;
    this.source = null;
    this.node = null;
    this.analyser = null;

    if (this.audioContext) {
      try {
        await this.audioContext.close();
      } catch (contextError) {
        console.warn('Failed to close AudioContext', contextError);
      }
      this.audioContext = null;
    }
    this.contextSampleRate = null;

    const packer = new WavPacker();
    const result = packer.pack(this.sampleRate, exportData.audio);
    return result;
  }

  /**
   * Performs a full cleanup of WavRecorder instance
   * Stops actively listening via microphone and removes existing listeners
   * @returns {Promise<true>}
   */
  async quit() {
    this.stopAmplitudeMonitoring();
    this.listenForDeviceChange(null);
    if (this.processor) {
      await this.end();
    }
    return true;
  }
}

globalThis.WavRecorder = WavRecorder;
