export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

export function arrayBufferToBase64(arrayBuffer: ArrayBuffer | Float32Array | Int16Array): string {
  let buffer: ArrayBufferLike;

  if (arrayBuffer instanceof Float32Array) {
    // Convert Float32Array to Int16Array first, then get the buffer
    buffer = float32ToInt16Array(arrayBuffer).buffer;
  } else if (arrayBuffer instanceof Int16Array) {
    buffer = arrayBuffer.buffer;
  } else {
    buffer = arrayBuffer;
  }

  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000; // 32KB chunk size

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, Array.from(chunk));
  }

  return btoa(binary);
}

function float32ToInt16Array(float32Array: Float32Array): Int16Array {
  const int16Array = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    // Clamp the value to [-1, 1] and convert to 16-bit integer
    const clamped = Math.max(-1, Math.min(1, float32Array[i]));
    int16Array[i] = Math.round(clamped * 0x7fff);
  }
  return int16Array;
}
