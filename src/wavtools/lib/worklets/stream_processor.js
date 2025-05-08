export const StreamProcessorWorklet = `
class StreamProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.hasStarted = false;
    this.hasInterrupted = false;
    this.isPaused = false; // New flag for pause state
    this.outputBuffers = [];
    this.bufferLength = 128;
    this.write = { buffer: new Float32Array(this.bufferLength), trackId: null };
    this.writeOffset = 0;
    this.trackSampleOffsets = {};
    this.port.onmessage = (event) => {
      if (event.data) {
        const payload = event.data;
        if (payload.event === 'write') {
          const int16Array = payload.buffer;
          const float32Array = new Float32Array(int16Array.length);
          for (let i = 0; i < int16Array.length; i++) {
            float32Array[i] = int16Array[i] / 0x8000; // Convert Int16 to Float32
          }
          this.writeData(float32Array, payload.trackId);
        } else if (
          payload.event === 'offset' ||
          payload.event === 'interrupt'
        ) {
          const requestId = payload.requestId;
          const trackId = this.write.trackId;
          const offset = this.trackSampleOffsets[trackId] || 0;
          this.port.postMessage({
            event: 'offset',
            requestId,
            trackId,
            offset,
          });
          if (payload.event === 'interrupt') {
            this.hasInterrupted = true;
          }
        } else if (payload.event === 'pause') {
          this.isPaused = true;
        } else if (payload.event === 'play') {
          this.isPaused = false;
        } else {
          throw new Error(\`Unhandled event "\${payload.event}"\`);
        }
      }
    };
  }

  writeData(float32Array, trackId = null) {
    let { buffer } = this.write;
    let offset = this.writeOffset;
    for (let i = 0; i < float32Array.length; i++) {
      buffer[offset++] = float32Array[i];
      if (offset >= buffer.length) {
        this.outputBuffers.push(this.write);
        this.write = { buffer: new Float32Array(this.bufferLength), trackId };
        buffer = this.write.buffer;
        offset = 0;
      }
    }
    this.writeOffset = offset;
    return true;
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    const outputChannelData = output[0];
    const outputBuffers = this.outputBuffers;

    if (this.hasInterrupted) {
      this.port.postMessage({ event: 'stop' });
      return false; // Stop processing if interrupted
    }

    if (this.isPaused) {
      // If paused, output silence but keep the processor alive
      for (let i = 0; i < outputChannelData.length; i++) {
        outputChannelData[i] = 0;
      }
      return true; // Continue processing (silence)
    }

    if (outputBuffers.length > 0) {
      this.hasStarted = true;
      const { buffer, trackId } = outputBuffers.shift();
      for (let i = 0; i < outputChannelData.length; i++) {
        outputChannelData[i] = buffer[i] || 0; // Fill output with buffer data or 0 if buffer is shorter
      }
      if (trackId) {
        this.trackSampleOffsets[trackId] =
          (this.trackSampleOffsets[trackId] || 0) + buffer.length;
      }
      return true; // Continue processing
    } else if (this.hasStarted) {
      // No more buffers and playback had started and is not paused
      this.port.postMessage({ event: 'stop' });
      this.hasStarted = false; // Reset for next playback
      return false; // Stop processing
    } else {
      // Not started, not paused, no buffers - output silence and wait for data
      for (let i = 0; i < outputChannelData.length; i++) {
        outputChannelData[i] = 0;
      }
      return true; // Keep processor alive
    }
  }
}

registerProcessor('stream_processor', StreamProcessor);
`;

const script = new Blob([StreamProcessorWorklet], {
  type: 'application/javascript',
});
const src = URL.createObjectURL(script);
export const StreamProcessorSrc = src;
