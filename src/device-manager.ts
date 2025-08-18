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
  onDeviceDisconnected?: (deviceId: string) => void;
  onDeviceSwitched?: (fromDeviceId: string, toDeviceId: string) => void;
  onVADReinitializationRequired?: () => void;
  onAudioRecordingRestartRequired?: () => void;
}

export interface DeviceManagerOptions {
  /** Enable automatic device switching when current device is disconnected */
  autoSwitchOnDisconnect?: boolean;
  /** Enable device change event listening */
  listenForDeviceChanges?: boolean;
  /** Priority order for device selection (default: ['default', 'system_default', 'first_available']) */
  devicePriority?: ('default' | 'system_default' | 'first_available')[];
}

export class DeviceManager {
  private wavRecorder: any; // WavRecorder instance
  private callbacks: DeviceManagerCallbacks;
  private currentDeviceId: string | null = null;
  private options: Required<DeviceManagerOptions>;
  private deviceChangeListener: ((devices: any[]) => void) | null = null;
  private isSwitching: boolean = false;

  constructor(wavRecorder: any, callbacks: DeviceManagerCallbacks, options: DeviceManagerOptions = {}) {
    this.wavRecorder = wavRecorder;
    this.callbacks = callbacks;
    this.options = {
      autoSwitchOnDisconnect: options.autoSwitchOnDisconnect ?? true,
      listenForDeviceChanges: options.listenForDeviceChanges ?? true,
      devicePriority: options.devicePriority ?? ['default', 'system_default', 'first_available'],
    };

    // Initialize current device ID from the current stream
    this._initializeCurrentDeviceId();

    // Set up device change listening if enabled
    if (this.options.listenForDeviceChanges) {
      this._setupDeviceChangeListener();
    }
  }

  /**
   * Initializes the current device ID from the current audio stream
   */
  private _initializeCurrentDeviceId(): void {
    try {
      const currentStream = this.wavRecorder.getStream();
      if (currentStream) {
        const currentTrack = currentStream.getAudioTracks()[0];
        if (currentTrack) {
          const deviceId = currentTrack.getSettings().deviceId;
          this.currentDeviceId = deviceId;
          console.log(`Initialized current device ID: ${deviceId}`);
        }
      }
    } catch (error) {
      console.warn('Could not initialize current device ID:', error);
    }
  }

  /**
   * Sets up the device change event listener to detect when devices are added/removed
   */
  private _setupDeviceChangeListener(): void {
    if (!this.wavRecorder || !this.wavRecorder.listenForDeviceChange) {
      console.warn('WavRecorder does not support device change listening');
      return;
    }

    this.deviceChangeListener = async (devices: any[]) => {
      try {
        console.log('Device change detected:', devices);
        console.log('Current device ID before change:', this.currentDeviceId);

        // If we don't have a current device ID, try to get it from the current stream
        if (!this.currentDeviceId) {
          this._initializeCurrentDeviceId();
        }

        // Check if current device is still available
        const currentDeviceStillAvailable = this.currentDeviceId && devices.some((device) => device.deviceId === this.currentDeviceId);

        console.log('Current device still available:', currentDeviceStillAvailable);

        if (!currentDeviceStillAvailable && this.currentDeviceId) {
          console.log(`Current device ${this.currentDeviceId} is no longer available`);

          // Notify about device disconnection
          if (this.callbacks.onDeviceDisconnected) {
            this.callbacks.onDeviceDisconnected(this.currentDeviceId);
          }

          // Auto-switch to next available device if enabled
          if (this.options.autoSwitchOnDisconnect && !this.isSwitching) {
            console.log('Attempting automatic device switch...');
            await this._autoSwitchToNextDevice(devices);
          }
        } else if (currentDeviceStillAvailable) {
          console.log(`Current device ${this.currentDeviceId} is still available`);
        }

        // Update device list and notify
        const audioDevices = await this.getAudioDevices();
        this.callbacks.onDeviceChange(audioDevices);
      } catch (error) {
        console.error('Error handling device change:', error);
        this.callbacks.onDeviceError(error instanceof Error ? error : new Error(String(error)));
      }
    };

    // Start listening for device changes
    this.wavRecorder.listenForDeviceChange(this.deviceChangeListener);
  }

  /**
   * Automatically switches to the next available device based on priority
   */
  private async _autoSwitchToNextDevice(availableDevices: any[]): Promise<void> {
    if (this.isSwitching) {
      console.log('Device switch already in progress, skipping');
      return;
    }

    this.isSwitching = true;

    try {
      // Get fresh device list to ensure we have the most up-to-date information
      const freshDevices = await this.wavRecorder.listDevices();
      console.log('Fresh device list for auto-switching:', freshDevices);

      const nextDeviceId = this._selectNextBestDevice(freshDevices);

      if (nextDeviceId && nextDeviceId !== this.currentDeviceId) {
        console.log(`Auto-switching from ${this.currentDeviceId} to ${nextDeviceId}`);

        const fromDeviceId = this.currentDeviceId;
        await this.setInputDevice(nextDeviceId);

        // Notify about successful device switch
        if (this.callbacks.onDeviceSwitched) {
          this.callbacks.onDeviceSwitched(fromDeviceId!, nextDeviceId);
        }

        // Notify that VAD reinitialization is required
        if (this.callbacks.onVADReinitializationRequired) {
          console.log('Notifying that VAD reinitialization is required');
          this.callbacks.onVADReinitializationRequired();
        }

        // Notify that audio recording restart is required
        if (this.callbacks.onAudioRecordingRestartRequired) {
          console.log('Notifying that audio recording restart is required');
          this.callbacks.onAudioRecordingRestartRequired();
        }
      } else {
        console.log('No suitable device found for auto-switching');
        if (nextDeviceId === this.currentDeviceId) {
          console.log('Next device is the same as current device, no switch needed');
        }
      }
    } catch (error) {
      console.error('Failed to auto-switch device:', error);
      this.callbacks.onDeviceError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.isSwitching = false;
    }
  }

  /**
   * Selects the next best device based on priority order
   */
  private _selectNextBestDevice(availableDevices: any[]): string | null {
    const audioInputDevices = availableDevices.filter((device) => device.kind === 'audioinput');

    if (audioInputDevices.length === 0) {
      return null;
    }

    // Try to find device based on priority order
    for (const priority of this.options.devicePriority) {
      let selectedDevice: any = null;

      switch (priority) {
        case 'default':
          // Look for device with default: true
          selectedDevice = audioInputDevices.find((device) => device.default === true);
          break;

        case 'system_default':
          // Look for device with deviceId === 'default'
          selectedDevice = audioInputDevices.find((device) => device.deviceId === 'default');
          break;

        case 'first_available':
          // Take the first available device
          selectedDevice = audioInputDevices[0];
          break;
      }

      if (selectedDevice && selectedDevice.deviceId !== this.currentDeviceId) {
        return selectedDevice.deviceId;
      }
    }

    // If no device found based on priority, return the first available non-current device
    const nonCurrentDevice = audioInputDevices.find((device) => device.deviceId !== this.currentDeviceId);
    return nonCurrentDevice ? nonCurrentDevice.deviceId : null;
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
   * Manually refreshes the current device ID from the current stream
   */
  refreshCurrentDeviceId(): void {
    this._initializeCurrentDeviceId();
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
      console.log('Internal current device ID:', this.currentDeviceId);

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

      // Check if current device is in the device list
      if (this.currentDeviceId) {
        const deviceInList = devices.find((d) => d.deviceId === this.currentDeviceId);
        console.log('Current device in device list:', !!deviceInList);
        if (!deviceInList) {
          console.warn('Current device ID not found in device list - this may indicate a disconnection');
        }
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

  /**
   * Manually triggers a device switch to the next available device
   */
  async switchToNextDevice(): Promise<void> {
    try {
      const devices = await this.wavRecorder.listDevices();
      await this._autoSwitchToNextDevice(devices);
    } catch (error) {
      console.error('Error switching to next device:', error);
      this.callbacks.onDeviceError(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  /**
   * Gets the device manager options
   */
  getOptions(): Required<DeviceManagerOptions> {
    return this.options;
  }

  /**
   * Updates the device manager options
   */
  updateOptions(newOptions: Partial<DeviceManagerOptions>): void {
    this.options = { ...this.options, ...newOptions };

    // Re-setup device change listener if the option changed
    if (newOptions.listenForDeviceChanges !== undefined) {
      if (this.deviceChangeListener) {
        this.wavRecorder.listenForDeviceChange(null);
        this.deviceChangeListener = null;
      }

      if (this.options.listenForDeviceChanges) {
        this._setupDeviceChangeListener();
      }
    }
  }

  /**
   * Cleanup method to remove event listeners
   */
  destroy(): void {
    if (this.deviceChangeListener && this.wavRecorder) {
      this.wavRecorder.listenForDeviceChange(null);
      this.deviceChangeListener = null;
    }
  }
}
