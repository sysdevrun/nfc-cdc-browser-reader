/**
 * Unified NFC Device interface that works with both WebUSB and Web Serial
 * Protocol specific to RDR-518 NFC Reader
 */

import { UsbCdcDevice, transceive as usbTransceive, toHex, fromHex } from './usb-cdc';
import { SerialDevice, transceiveSerial } from './web-serial';

export type ConnectionType = 'usb' | 'serial';

export interface NfcDevice {
  type: ConnectionType;
  name: string;
  usbDevice?: UsbCdcDevice;
  serialDevice?: SerialDevice;
}

export interface NfcCommandResult {
  success: boolean;
  data?: Uint8Array;
  message: string;
  hexData?: string;
  atqa?: string;
  sak?: string;
}

/**
 * Send raw bytes to the device and get response
 */
export async function transceive(
  device: NfcDevice,
  command: Uint8Array,
  timeout: number = 2000
): Promise<Uint8Array> {
  if (device.type === 'usb' && device.usbDevice) {
    return await usbTransceive(device.usbDevice, command, 256, timeout);
  } else if (device.type === 'serial' && device.serialDevice) {
    return await transceiveSerial(device.serialDevice, command, timeout);
  }
  throw new Error('No device connected');
}

/**
 * Send command and parse response
 */
export async function sendCommand(
  device: NfcDevice,
  command: Uint8Array,
  timeout: number = 2000
): Promise<NfcCommandResult> {
  try {
    const response = await transceive(device, command, timeout);

    if (response.length === 0) {
      return {
        success: false,
        message: 'No response from reader',
      };
    }

    return {
      success: true,
      data: response,
      hexData: toHex(response),
      message: 'OK',
    };
  } catch (error) {
    return {
      success: false,
      message: `Command failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Get card UID using RDR-518 proprietary command
 * Command: 80 0a 01 03 00 00 02 11 03 01 01 14 00 9c f8
 * Response format: [LEN] 01 03 00 [ATQA 2 bytes] 00 [SAK] [UID 4 bytes] [STATUS] [CRC-16 2 bytes]
 * Example: 0b 01 03 00 05 06 00 08 8d 69 5d f1 00 e2 4e
 */
export async function getCardUid(device: NfcDevice): Promise<NfcCommandResult> {
  const command = fromHex('80 0a 01 03 00 00 02 11 03 01 01 14 00 9c f8');
  const result = await sendCommand(device, command);

  if (result.success && result.data && result.data.length >= 13) {
    // Parse RDR-518 response format
    // [0] = LEN (0x0b = 11)
    // [1-3] = Header (01 03 00)
    // [4-5] = ATQA
    // [6] = 00
    // [7] = SAK
    // [8-11] = UID (4 bytes)
    // [12] = Status
    // [13-14] = CRC-16

    const len = result.data[0];
    const atqa = result.data.subarray(4, 6);
    const sak = result.data[7];
    const uid = result.data.subarray(8, 12);
    const status = result.data[12];

    if (status === 0x00 && len === 0x0b) {
      return {
        success: true,
        data: uid,
        hexData: toHex(uid),
        atqa: toHex(atqa),
        sak: sak.toString(16).padStart(2, '0').toUpperCase(),
        message: `UID: ${toHex(uid)}`,
      };
    } else {
      return {
        success: false,
        data: result.data,
        hexData: result.hexData,
        message: 'No card detected or read error',
      };
    }
  }

  if (result.success && result.data) {
    return {
      success: false,
      data: result.data,
      hexData: result.hexData,
      message: 'No card detected',
    };
  }

  return result;
}

/**
 * Send custom command (hex string)
 */
export async function sendCustomCommand(
  device: NfcDevice,
  hexCommand: string
): Promise<NfcCommandResult> {
  try {
    const command = fromHex(hexCommand);
    return await sendCommand(device, command);
  } catch (error) {
    return {
      success: false,
      message: `Invalid hex command: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// Re-export utilities
export { toHex, fromHex };
