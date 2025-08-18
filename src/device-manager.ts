export interface AudioDevice {
  deviceId: string;
  label: string;
  default: boolean;
  current: boolean;
  enabled: boolean;
  muted: boolean;
}

export interface DeviceManagerCallbacks {
  onDeviceChange: (devices: AudioDevice[]) => void;
  onDeviceError: (error: Error) => void;
}

export class DeviceManager {
  private wavRecorder: any; // WavRecorder instance
  private callbacks: DeviceManagerCallbacks;
  private currentDeviceId: string | null = null;

  constructor(wavRecorder: any, callbacks: DeviceManagerCallbacks) {
    this.wavRecorder = wavRecorder;
    this.callbacks = callbacks;
  }

  /**
   * Gets all available audio input devices with their current status
   */
  async getAudioDevices(): Promise<AudioDevice[]> {
    try {
      const devices = await this.wavRecorder.listDevices();
      const currentStream = this.wavRecorder.getStream();
      const currentTrack = currentStream?.getAudioTracks()[0];

      return devices.map((device: any) => ({
        deviceId: device.deviceId,
        label: device.label,
        default: device.default || false,
        current: currentTrack ? device.deviceId === currentTrack.getSettings().deviceId : false,
        enabled: currentTrack ? currentTrack.enabled : false,
        muted: currentTrack ? currentTrack.muted : false,
      }));
    } catch (error) {
      console.error('Error getting audio devices:', error);
      this.callbacks.onDeviceError(error instanceof Error ? error : new Error(String(error)));
      return [];
    }
  }

  /**
   * Gets the currently active audio input device ID
   */
  getCurrentDeviceId(): string | null {
    try {
      const currentStream = this.wavRecorder.getStream();
      const currentTrack = currentStream?.getAudioTracks()[0];
      const deviceId = currentTrack?.getSettings().deviceId;
      return deviceId || null;
    } catch (error) {
      console.error('Error getting current device ID:', error);
      return null;
    }
  }

  /**
   * Gets the default microphone device ID
   */
  async getDefaultDeviceId(): Promise<string | null> {
    try {
      const devices = await this.wavRecorder.listDevices();
      const defaultDevice = devices.find((device: any) => device.default === true);
      return defaultDevice ? defaultDevice.deviceId : null;
    } catch (error) {
      console.error('Error getting default device:', error);
      this.callbacks.onDeviceError(error instanceof Error ? error : new Error(String(error)));
      return null;
    }
  }

  /**
   * Switches the input device for the microphone and restarts recording
   */
  async setInputDevice(deviceId: string): Promise<void> {
    try {
      console.log(`Switching to input device: ${deviceId}`);

      if (this.wavRecorder) {
        try {
          await this.wavRecorder.end();
        } catch (e) {
          console.warn('Error ending recorder:', e);
        }
        try {
          await this.wavRecorder.quit();
        } catch (e) {
          console.warn('Error quitting recorder:', e);
        }
      }

      await this.wavRecorder.begin(deviceId);
      this.currentDeviceId = deviceId;

      // Notify about device change
      const devices = await this.getAudioDevices();
      this.callbacks.onDeviceChange(devices);

      console.log(`Successfully switched to input device: ${deviceId}`);
    } catch (error) {
      console.error(`Failed to switch to input device ${deviceId}:`, error);
      this.callbacks.onDeviceError(error instanceof Error ? error : new Error(String(error)));
      throw new Error(`Failed to switch to input device: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Forces a refresh of the device list by re-requesting permissions
   */
  async refreshAudioDevices(): Promise<AudioDevice[]> {
    try {
      // Re-request permissions to refresh device list
      await navigator.mediaDevices.getUserMedia({ audio: true });
      const devices = await this.getAudioDevices();
      this.callbacks.onDeviceChange(devices);
      return devices;
    } catch (error) {
      console.error('Error refreshing audio devices:', error);
      this.callbacks.onDeviceError(error instanceof Error ? error : new Error(String(error)));
      return [];
    }
  }

  /**
   * Gets the current audio stream
   */
  getCurrentStream(): MediaStream | null {
    return this.wavRecorder.getStream();
  }

  /**
   * Logs detailed information about all devices, current device, and default device
   */
  async logDeviceStatus(): Promise<void> {
    try {
      console.log('=== Device Status ===');

      const devices = await this.getAudioDevices();
      console.log('All devices:', devices);

      const currentDeviceId = this.getCurrentDeviceId();
      console.log('Current device ID:', currentDeviceId);

      const defaultDeviceId = await this.getDefaultDeviceId();
      console.log('Default device ID:', defaultDeviceId);

      if (currentDeviceId) {
        const currentDevice = devices.find((d) => d.deviceId === currentDeviceId);
        console.log('Current device details:', currentDevice);
      }

      if (defaultDeviceId) {
        const defaultDevice = devices.find((d) => d.deviceId === defaultDeviceId);
        console.log('Default device details:', defaultDevice);
      }

      console.log('===================');
    } catch (error) {
      console.error('Error logging device status:', error);
    }
  }

  /**
   * Gets the current device ID
   */
  getCurrentDeviceIdInternal(): string | null {
    return this.currentDeviceId;
  }

  /**
   * Sets the current device ID
   */
  setCurrentDeviceId(deviceId: string): void {
    this.currentDeviceId = deviceId;
  }
}
