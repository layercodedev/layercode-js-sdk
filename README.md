# Layercode JavaScript SDK

A JavaScript SDK for integrating Layercode voice agents into web applications.

## Installation

```bash
npm install @layercode/js-sdk
```

Or load it directly:

```html
<script src="https://cdn.jsdelivr.net/npm/@layercode/js-sdk@VERSION/dist/layercode-js-sdk.min.js"></script>
```

> Device helpers require a secure context (https/localhost) and browser `navigator.mediaDevices` support.

## Device helpers

The SDK now exposes microphone helpers so you can build device pickers or react to hot-swaps without reimplementing the tricky parts:

```ts
import {
  LayercodeClient,
  listAudioInputDevices,
  watchAudioInputDevices,
  type LayercodeAudioInputDevice,
} from '@layercode/js-sdk';

async function main() {
  const devices: LayercodeAudioInputDevice[] = await listAudioInputDevices();
  console.log('Default mic:', devices.find((d) => d.default));

  const stopWatching = watchAudioInputDevices((nextDevices) => {
    console.log('Devices changed', nextDevices);
  });

  const client = new LayercodeClient({ /* ... */ });
  await client.setPreferredInputDevice('abcdef123'); // persists your pick even before connecting
  await client.connect();

  // Later, when you need to follow the system default again:
  await client.setPreferredInputDevice('default');

  // Stop watching once the page/component unmounts
  stopWatching();
}

main().catch(console.error);
```

- `listAudioInputDevices()` triggers a permission prompt (once) and returns labeled devices with a `default` flag.
- `watchAudioInputDevices(cb)` re-emits whenever the browser fires `devicechange`, de-duping noisy events for you.
- `client.setPreferredInputDevice(deviceId | 'default' | null)` pins recording to a concrete device ID, or passes `'default'`/`null` to follow the operating system’s default input.

All helpers guard against stale media streams and ensure tracks are stopped whenever we only need labels, which avoids the “mic busy” bugs that browsers frequently hit.

## Documentation

Full API reference lives in the docs: [https://docs.layercode.com/sdk-reference/vanilla-js-sdk](https://docs.layercode.com/sdk-reference/vanilla-js-sdk)
