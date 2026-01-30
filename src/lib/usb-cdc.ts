/**
 * USB CDC (Communications Device Class) interface for NFC readers
 *
 * This module provides low-level USB CDC communication for devices like
 * the ACS ACR1252U, ACR122U, ACR1281S-C1 (ACR518) in CDC/serial mode.
 */

export interface UsbCdcDevice {
  device: USBDevice;
  interfaceNumber: number;
  endpointIn: number;
  endpointOut: number;
}

export interface CdcConnectionResult {
  success: boolean;
  device?: UsbCdcDevice;
  error?: string;
}

// Known NFC reader USB vendor/product IDs
export const KNOWN_NFC_READERS = [
  { vendorId: 0x1fd3, productId: 0x0108, name: 'RDR-518 NFC Reader' },
  { vendorId: 0x072f, productId: 0x2200, name: 'ACS ACR122U' },
  { vendorId: 0x072f, productId: 0x223b, name: 'ACS ACR1252U' },
  { vendorId: 0x072f, productId: 0x8911, name: 'ACS ACR1281S-C1 (ACR518)' },
  { vendorId: 0x072f, productId: 0x8903, name: 'ACS ACR38U-CCID' },
  { vendorId: 0x072f, productId: 0x90cc, name: 'ACS ACR38U' },
  { vendorId: 0x072f, productId: 0x2214, name: 'ACS ACR1222L' },
  { vendorId: 0x1a86, productId: 0x7523, name: 'CH340 Serial (Generic CDC)' },
  { vendorId: 0x0403, productId: 0x6001, name: 'FTDI Serial' },
];

/**
 * Check if WebUSB is supported in the current browser
 */
export function isWebUsbSupported(): boolean {
  return 'usb' in navigator;
}

/**
 * Request access to a USB device
 * For CDC devices, we look for CDC-ACM or vendor-specific interfaces
 */
export async function requestDevice(): Promise<CdcConnectionResult> {
  if (!isWebUsbSupported()) {
    return {
      success: false,
      error: 'WebUSB is not supported in this browser. Please use Chrome, Edge, or Opera.',
    };
  }

  try {
    // Request any USB device - user will select from the popup
    const device = await navigator.usb.requestDevice({
      filters: [
        // RDR-518 NFC Reader
        { vendorId: 0x1fd3 },
        // ACS readers
        { vendorId: 0x072f },
        // Common USB-Serial chips
        { vendorId: 0x1a86 }, // CH340
        { vendorId: 0x0403 }, // FTDI
        { vendorId: 0x10c4 }, // Silicon Labs CP210x
        { vendorId: 0x067b }, // Prolific PL2303
      ],
    });

    return await connectToDevice(device);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') {
      return {
        success: false,
        error: 'No device selected. Please select an NFC reader.',
      };
    }
    return {
      success: false,
      error: `Failed to request device: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Connect to a USB device and configure CDC interface
 */
export async function connectToDevice(device: USBDevice): Promise<CdcConnectionResult> {
  try {
    await device.open();

    // Select configuration 1 if not already selected
    if (device.configuration === null) {
      await device.selectConfiguration(1);
    }

    // Find CDC interface - look for CDC-ACM (class 0x02) or vendor-specific (0xFF)
    let cdcInterface: USBInterface | null = null;
    let dataInterface: USBInterface | null = null;

    for (const iface of device.configuration?.interfaces || []) {
      const alt = iface.alternate;
      // CDC Control interface (class 2, subclass 2 = ACM)
      if (alt.interfaceClass === 0x02 && alt.interfaceSubclass === 0x02) {
        cdcInterface = iface;
      }
      // CDC Data interface (class 0x0a)
      if (alt.interfaceClass === 0x0a) {
        dataInterface = iface;
      }
      // Vendor-specific interface (some readers use this)
      if (alt.interfaceClass === 0xff) {
        dataInterface = iface;
      }
    }

    // Use data interface if found, otherwise use the first interface with bulk endpoints
    const targetInterface = dataInterface || cdcInterface || device.configuration?.interfaces[0];

    if (!targetInterface) {
      return {
        success: false,
        error: 'No suitable interface found on the device',
      };
    }

    await device.claimInterface(targetInterface.interfaceNumber);

    // Find bulk IN and OUT endpoints
    let endpointIn = 0;
    let endpointOut = 0;

    for (const endpoint of targetInterface.alternate.endpoints) {
      if (endpoint.type === 'bulk') {
        if (endpoint.direction === 'in') {
          endpointIn = endpoint.endpointNumber;
        } else {
          endpointOut = endpoint.endpointNumber;
        }
      }
    }

    // If no bulk endpoints found, try interrupt endpoints
    if (endpointIn === 0 || endpointOut === 0) {
      for (const endpoint of targetInterface.alternate.endpoints) {
        if (endpoint.type === 'interrupt') {
          if (endpoint.direction === 'in' && endpointIn === 0) {
            endpointIn = endpoint.endpointNumber;
          } else if (endpoint.direction === 'out' && endpointOut === 0) {
            endpointOut = endpoint.endpointNumber;
          }
        }
      }
    }

    if (endpointIn === 0 || endpointOut === 0) {
      return {
        success: false,
        error: 'Could not find required bulk/interrupt endpoints',
      };
    }

    // For CDC-ACM devices, set line coding (baud rate, etc.)
    if (cdcInterface) {
      try {
        // SET_LINE_CODING: 115200 baud, 8N1
        const lineCoding = new ArrayBuffer(7);
        const view = new DataView(lineCoding);
        view.setUint32(0, 115200, true); // baud rate
        view.setUint8(4, 0); // 1 stop bit
        view.setUint8(5, 0); // no parity
        view.setUint8(6, 8); // 8 data bits

        await device.controlTransferOut({
          requestType: 'class',
          recipient: 'interface',
          request: 0x20, // SET_LINE_CODING
          value: 0,
          index: cdcInterface.interfaceNumber,
        }, lineCoding);

        // SET_CONTROL_LINE_STATE: DTR and RTS
        await device.controlTransferOut({
          requestType: 'class',
          recipient: 'interface',
          request: 0x22, // SET_CONTROL_LINE_STATE
          value: 0x03, // DTR | RTS
          index: cdcInterface.interfaceNumber,
        });
      } catch {
        // Some devices don't support these commands, continue anyway
        console.log('CDC line coding setup failed, continuing...');
      }
    }

    return {
      success: true,
      device: {
        device,
        interfaceNumber: targetInterface.interfaceNumber,
        endpointIn,
        endpointOut,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to connect: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Disconnect from a USB device
 */
export async function disconnectDevice(cdcDevice: UsbCdcDevice): Promise<void> {
  try {
    await cdcDevice.device.releaseInterface(cdcDevice.interfaceNumber);
    await cdcDevice.device.close();
  } catch (error) {
    console.error('Error disconnecting device:', error);
  }
}

/**
 * Send data to the USB device
 */
export async function sendData(cdcDevice: UsbCdcDevice, data: Uint8Array): Promise<void> {
  // Create a new ArrayBuffer to ensure compatibility with WebUSB
  const buffer = new ArrayBuffer(data.length);
  new Uint8Array(buffer).set(data);
  await cdcDevice.device.transferOut(cdcDevice.endpointOut, buffer);
}

/**
 * Receive data from the USB device
 */
export async function receiveData(cdcDevice: UsbCdcDevice, length: number = 64, timeout: number = 1000): Promise<Uint8Array> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    try {
      const result = await cdcDevice.device.transferIn(cdcDevice.endpointIn, length);
      if (result.data && result.data.byteLength > 0) {
        return new Uint8Array(result.data.buffer);
      }
    } catch {
      // Timeout or no data, continue waiting
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  return new Uint8Array(0);
}

/**
 * Send command and receive response
 */
export async function transceive(
  cdcDevice: UsbCdcDevice,
  command: Uint8Array,
  responseLength: number = 64,
  timeout: number = 2000
): Promise<Uint8Array> {
  await sendData(cdcDevice, command);
  return await receiveData(cdcDevice, responseLength, timeout);
}

/**
 * Get device info string
 */
export function getDeviceInfo(device: USBDevice): string {
  const known = KNOWN_NFC_READERS.find(
    r => r.vendorId === device.vendorId && r.productId === device.productId
  );

  if (known) {
    return known.name;
  }

  return device.productName || `USB Device (${device.vendorId.toString(16)}:${device.productId.toString(16)})`;
}

/**
 * Convert byte array to hex string
 */
export function toHex(data: Uint8Array): string {
  return Array.from(data)
    .map(b => b.toString(16).padStart(2, '0').toUpperCase())
    .join(' ');
}

/**
 * Convert hex string to byte array
 */
export function fromHex(hex: string): Uint8Array {
  const cleanHex = hex.replace(/\s+/g, '');
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleanHex.substr(i * 2, 2), 16);
  }
  return bytes;
}
