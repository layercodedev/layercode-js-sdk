export interface AudioDevice {
  deviceId: string;
  label: string;
  default: boolean;
  current: boolean;
}

export interface DeviceManagerCallbacks {
  onDeviceChange: (devices: AudioDevice[]) => void;
  onDeviceError: (error: Error) => void;
  onDeviceDisconnected?: (deviceId: string) => void;
  onDeviceSwitched?: (fromDeviceId: string, toDeviceId: string) => void;
}

export interface DeviceManagerOptions {
  /** Enable automatic device switching when current device is disconnected */
  autoSwitchOnDisconnect?: boolean;
  /** Enable device change event listening */
  listenForDeviceChanges?: boolean;
}

interface MediaDeviceWithDefault extends MediaDeviceInfo {
  default?: boolean;
}

export class DeviceManager {
  private wavRecorder: any; // WavRecorder instance
  private callbacks: DeviceManagerCallbacks;
  private currentDeviceId: string | null = null;
  private options: Required<DeviceManagerOptions>;
  private deviceChangeListener: ((devices: MediaDeviceWithDefault[]) => void) | null = null;

  constructor(wavRecorder: any, callbacks: DeviceManagerCallbacks, options: DeviceManagerOptions = {}) {
    this.wavRecorder = wavRecorder;
    this.callbacks = callbacks;
    this.options = {
      autoSwitchOnDisconnect: options.autoSwitchOnDisconnect ?? true,
      listenForDeviceChanges: options.listenForDeviceChanges ?? true,
    };

    this.updateCurrentDeviceId();

    if (this.options.listenForDeviceChanges) {
      this._setupDeviceChangeListener();
    }
  }

  /**
   * Updates the current device ID from the active audio stream
   */
  updateCurrentDeviceId(): void {
    try {
      const currentStream = this.wavRecorder.getStream();
      const currentTrack = currentStream?.getAudioTracks()[0];
      if (currentTrack) {
        this.currentDeviceId = currentTrack.getSettings().deviceId || null;
      }
    } catch (error) {
      // Silent fail - device ID will be null
    }
  }

  /**
   * Handles errors consistently
   */
  private handleError(message: string, error: unknown): Error {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error(message, err);
    this.callbacks.onDeviceError(err);
    return err;
  }

  /**
   * Sets up the device change event listener
   */
  private _setupDeviceChangeListener(): void {
    this.deviceChangeListener = async (devices: MediaDeviceWithDefault[]) => {
      try {
        // Ensure we have current device ID
        if (!this.currentDeviceId) {
          this.updateCurrentDeviceId();
        }

        // Check if current device was disconnected
        const currentDeviceExists = devices.some((device) => device.deviceId === this.currentDeviceId);

        if (!currentDeviceExists && this.currentDeviceId) {
          // Device was disconnected
          if (this.callbacks.onDeviceDisconnected) {
            this.callbacks.onDeviceDisconnected(this.currentDeviceId);
          }

          // Auto-switch if enabled
          if (this.options.autoSwitchOnDisconnect) {
            await this._switchToNextDevice();
          }
        }

        // Update device list
        const audioDevices = await this.getAudioDevices();
        this.callbacks.onDeviceChange(audioDevices);
      } catch (error) {
        this.handleError('Error handling device change:', error);
      }
    };

    this.wavRecorder.listenForDeviceChange(this.deviceChangeListener);
  }

  /**
   * Switches to the next available device
   */
  private async _switchToNextDevice(): Promise<void> {
    try {
      const devices = await this.wavRecorder.listDevices();
      const audioInputs = devices.filter((d: MediaDeviceWithDefault) => d.kind === 'audioinput');
      
      // Find first device that's not the current one
      const nextDevice = audioInputs.find((d: MediaDeviceWithDefault) => d.deviceId !== this.currentDeviceId);
      
      if (nextDevice) {
        const fromDeviceId = this.currentDeviceId;
        await this.setInputDevice(nextDevice.deviceId);
        
        if (this.callbacks.onDeviceSwitched && fromDeviceId) {
          this.callbacks.onDeviceSwitched(fromDeviceId, nextDevice.deviceId);
        }
      }
    } catch (error) {
      this.handleError('Failed to auto-switch device:', error);
    }
  }

  /**
   * Gets all available audio input devices
   */
  async getAudioDevices(): Promise<AudioDevice[]> {
    try {
      const devices = await this.wavRecorder.listDevices();
      const currentStream = this.wavRecorder.getStream();
      const currentTrack = currentStream?.getAudioTracks()[0];
      const currentDeviceId = currentTrack?.getSettings().deviceId;

      return devices
        .filter((device: MediaDeviceWithDefault) => device.kind === 'audioinput')
        .map((device: MediaDeviceWithDefault) => ({
          deviceId: device.deviceId,
          label: device.label || 'Unknown Device',
          default: device.default || false,
          current: device.deviceId === currentDeviceId,
        }));
    } catch (error) {
      this.handleError('Error getting audio devices:', error);
      return [];
    }
  }

  /**
   * Switches the input device
   */
  async setInputDevice(deviceId: string): Promise<void> {
    try {
      // Clean up existing recorder
      try {
        await this.wavRecorder.end();
        await this.wavRecorder.quit();
      } catch {
        // Ignore cleanup errors
      }

      // Start with new device
      await this.wavRecorder.begin(deviceId);
      this.currentDeviceId = deviceId;

      // Notify about device change
      const devices = await this.getAudioDevices();
      this.callbacks.onDeviceChange(devices);
    } catch (error) {
      const err = this.handleError(`Failed to switch to device ${deviceId}:`, error);
      throw err;
    }
  }

  /**
   * Gets the current audio stream
   */
  getCurrentStream(): MediaStream | null {
    return this.wavRecorder.getStream();
  }

  /**
   * Manually triggers a device switch to the next available device
   */
  async switchToNextDevice(): Promise<void> {
    await this._switchToNextDevice();
  }

  /**
   * Cleanup method to remove event listeners
   */
  destroy(): void {
    if (this.deviceChangeListener) {
      this.wavRecorder.listenForDeviceChange(null);
      this.deviceChangeListener = null;
    }
  }
}