# Microphone Device Switching Fixes

This document describes the fixes implemented for microphone device switching issues in the Layercode JS SDK.

## Issues Fixed

### 1. VAD Not Reconnected After Device Change

**Problem**: When switching microphone devices using `setInputDevice()`, the Voice Activity Detection (VAD) system was not reinitialized with the new audio stream. This caused the VAD to continue using the old microphone input even though the audio recording was switched to the new device.

**Solution**: The `setInputDevice()` method now properly destroys the old VAD instance and reinitializes it with the new audio stream.

### 2. Default Device Selection Issues

**Problem**: When no specific device is specified, the system was relying on the browser's implicit default device selection, which could be unreliable, especially when the MacBook lid is closed.

**Solution**: The `begin()` method in `WavRecorder` now explicitly queries for the actual default device and uses it when no device ID is specified.

### 3. Device Status Tracking

**Problem**: There was no easy way to track which device was currently active or debug device selection issues.

**Solution**: Added several new methods to help track and debug device selection:

- `getCurrentDeviceId()` - Get the currently active device ID
- `getDefaultDeviceId()` - Get the system's default device ID
- `getAudioDevices()` - Get all available devices with their status
- `logDeviceStatus()` - Debug method to log current device status
- `forceVADReinitialization()` - Force VAD to reinitialize with current stream

## New Methods Added

### `setInputDevice(deviceId: string): Promise<void>`

Switches the input device and properly reinitializes the VAD system.

### `getCurrentDeviceId(): string | null`

Returns the device ID of the currently active microphone.

### `getDefaultDeviceId(): Promise<string | null>`

Returns the device ID of the system's default microphone.

### `getAudioDevices(): Promise<Array<MediaDeviceInfo & { default: boolean, current: boolean }>>`

Returns all available audio input devices with their current status.

### `refreshAudioDevices(): Promise<Array<MediaDeviceInfo & { default: boolean, current: boolean }>>`

Refreshes the device list by requesting new permissions.

### `logDeviceStatus(): Promise<void>`

Debug method that logs detailed information about the current device status.

### `forceVADReinitialization(): Promise<void>`

Forces the VAD system to reinitialize with the current audio stream.

## Usage Examples

### Basic Device Switching

```javascript
// Switch to a specific device
await client.setInputDevice('device-id-here');

// Get current device
const currentDevice = client.getCurrentDeviceId();
console.log('Current device:', currentDevice);
```

### Debugging Device Issues

```javascript
// Log current device status
await client.logDeviceStatus();

// Get all available devices
const devices = await client.getAudioDevices();
console.log('Available devices:', devices);

// Force VAD reinitialization
await client.forceVADReinitialization();
```

### Finding the Default Device

```javascript
// Get the system's default device
const defaultDevice = await client.getDefaultDeviceId();
console.log('Default device:', defaultDevice);

// Switch to the default device
if (defaultDevice) {
  await client.setInputDevice(defaultDevice);
}
```

## Testing

A test script `test-device-switching.js` is provided that can be run in the browser console to verify the fixes work correctly.

```javascript
// Test device switching
await testDeviceSwitching();

// Test VAD reinitialization
await testVADReinitialization();
```

## Debugging Tips

1. **Check Device Status**: Use `client.logDeviceStatus()` to see detailed information about current devices.

2. **Monitor VAD Initialization**: The console will now log when VAD is initialized and with which stream.

3. **Device Switching Logs**: The `setInputDevice()` method now provides detailed logging of the switching process.

4. **Force VAD Refresh**: If you suspect VAD is using the wrong stream, use `client.forceVADReinitialization()`.

## Common Issues and Solutions

### VAD Bars Not Going Green After Device Switch

- **Cause**: VAD is still using the old audio stream
- **Solution**: The fix automatically reinitializes VAD, but you can also manually call `forceVADReinitialization()`

### Wrong Device Selected on Startup

- **Cause**: Browser's implicit default device selection
- **Solution**: The fix now explicitly queries for the actual default device

### Device List Not Updated

- **Cause**: Permissions may have changed
- **Solution**: Use `refreshAudioDevices()` to refresh the device list

## Browser Compatibility

These fixes work with all modern browsers that support:

- `navigator.mediaDevices.getUserMedia()`
- `navigator.mediaDevices.enumerateDevices()`
- AudioWorklet API
- MediaStream API

## Notes

- Device switching requires proper cleanup of the old audio stream and VAD instance
- The VAD system is automatically reinitialized when switching devices
- All device operations are logged for debugging purposes
- The system now provides better error handling and user feedback
