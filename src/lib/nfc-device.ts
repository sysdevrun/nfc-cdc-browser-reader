/**
 * Unified NFC Device interface that works with both WebUSB and Web Serial
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
 * Send APDU command and parse response
 */
export async function sendApdu(
  device: NfcDevice,
  apdu: Uint8Array,
  timeout: number = 2000
): Promise<NfcCommandResult> {
  try {
    const response = await transceive(device, apdu, timeout);

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
 * Get card UID using GET DATA command
 * Standard APDU: FF CA 00 00 00
 */
export async function getCardUid(device: NfcDevice): Promise<NfcCommandResult> {
  const apdu = fromHex('FF CA 00 00 00');
  const result = await sendApdu(device, apdu);

  if (result.success && result.data && result.data.length >= 2) {
    const sw1 = result.data[result.data.length - 2];
    const sw2 = result.data[result.data.length - 1];

    if (sw1 === 0x90 && sw2 === 0x00) {
      const uid = result.data.subarray(0, result.data.length - 2);
      return {
        success: true,
        data: uid,
        hexData: toHex(uid),
        message: `UID: ${toHex(uid)} (${uid.length * 8}-bit)`,
      };
    } else if (sw1 === 0x6a && sw2 === 0x81) {
      return {
        success: false,
        message: 'No card present or function not supported',
      };
    } else {
      return {
        success: false,
        message: `Error: SW=${sw1.toString(16).padStart(2, '0')}${sw2.toString(16).padStart(2, '0')}`,
      };
    }
  }

  return result;
}

/**
 * Get reader firmware version
 */
export async function getFirmwareVersion(device: NfcDevice): Promise<NfcCommandResult> {
  const apdu = fromHex('FF 00 48 00 00');
  const result = await sendApdu(device, apdu);

  if (result.success && result.data) {
    try {
      const text = new TextDecoder().decode(result.data);
      if (text.length > 0 && /[\x20-\x7E]/.test(text)) {
        result.message = `Firmware: ${text.replace(/[\x00-\x1f\x90\x00]/g, '')}`;
      }
    } catch {
      // Keep hex data
    }
  }

  return result;
}

/**
 * Get reader serial number
 */
export async function getSerialNumber(device: NfcDevice): Promise<NfcCommandResult> {
  const apdu = fromHex('FF 00 4A 00 00');
  const result = await sendApdu(device, apdu);

  if (result.success && result.data) {
    try {
      const text = new TextDecoder().decode(result.data);
      if (text.length > 0) {
        result.message = `Serial: ${text.replace(/[\x00-\x1f\x90\x00]/g, '')}`;
      }
    } catch {
      // Keep hex data
    }
  }

  return result;
}

/**
 * Get card ATS (Answer To Select)
 */
export async function getCardAts(device: NfcDevice): Promise<NfcCommandResult> {
  const apdu = fromHex('FF CA 01 00 00');
  const result = await sendApdu(device, apdu);

  if (result.success && result.data && result.data.length >= 2) {
    const sw1 = result.data[result.data.length - 2];
    const sw2 = result.data[result.data.length - 1];

    if (sw1 === 0x90 && sw2 === 0x00) {
      const ats = result.data.subarray(0, result.data.length - 2);
      return {
        success: true,
        data: ats,
        hexData: toHex(ats),
        message: `ATS: ${toHex(ats)}`,
      };
    }
  }

  return {
    success: false,
    message: 'No ATS available',
  };
}

/**
 * Poll for card
 */
export async function pollCard(device: NfcDevice): Promise<NfcCommandResult> {
  const apdu = fromHex('FF 00 00 00 04 D4 4A 01 00');
  const result = await sendApdu(device, apdu);

  if (result.success && result.data && result.data.length > 0) {
    result.message = result.data.length > 2 ? 'Card detected' : 'No card in field';
  }

  return result;
}

/**
 * Turn antenna RF field ON
 */
export async function antennaOn(device: NfcDevice): Promise<NfcCommandResult> {
  const apdu = fromHex('FF 00 00 00 04 D4 32 01 01');
  const result = await sendApdu(device, apdu);
  result.message = result.success ? 'Antenna ON' : 'Failed to turn on antenna';
  return result;
}

/**
 * Turn antenna RF field OFF
 */
export async function antennaOff(device: NfcDevice): Promise<NfcCommandResult> {
  const apdu = fromHex('FF 00 00 00 04 D4 32 01 00');
  const result = await sendApdu(device, apdu);
  result.message = result.success ? 'Antenna OFF' : 'Failed to turn off antenna';
  return result;
}

/**
 * Control buzzer
 */
export async function buzzer(device: NfcDevice, durationMs: number = 100): Promise<NfcCommandResult> {
  const duration = Math.min(255, Math.floor(durationMs / 10));
  const apdu = new Uint8Array([0xff, 0x00, 0x52, duration, 0x00]);
  const result = await sendApdu(device, apdu);
  result.message = result.success ? `Buzzer: ${duration * 10}ms` : 'Buzzer command failed';
  return result;
}

/**
 * Control LED
 */
export async function ledControl(
  device: NfcDevice,
  redOn: boolean = false,
  greenOn: boolean = false
): Promise<NfcCommandResult> {
  let ledState = 0x00;
  if (redOn) ledState |= 0x01;
  if (greenOn) ledState |= 0x02;

  const apdu = new Uint8Array([0xff, 0x00, 0x40, ledState, 0x04, 0x01, 0x01, 0x01, 0x01]);
  const result = await sendApdu(device, apdu);
  result.message = `LED: Red=${redOn ? 'ON' : 'OFF'}, Green=${greenOn ? 'ON' : 'OFF'}`;
  return result;
}

/**
 * Load authentication key
 */
export async function loadKey(
  device: NfcDevice,
  keyNumber: number,
  key: Uint8Array
): Promise<NfcCommandResult> {
  if (key.length !== 6) {
    return { success: false, message: 'Key must be 6 bytes' };
  }

  const apdu = new Uint8Array([0xff, 0x82, 0x00, keyNumber & 0x01, 0x06, ...key]);
  const result = await sendApdu(device, apdu);

  if (result.success && result.data && result.data.length >= 2) {
    const sw1 = result.data[result.data.length - 2];
    const sw2 = result.data[result.data.length - 1];

    if (sw1 === 0x90 && sw2 === 0x00) {
      result.message = `Key ${keyNumber} loaded`;
    } else {
      result.success = false;
      result.message = `Load key failed: SW=${sw1.toString(16).padStart(2, '0')}${sw2.toString(16).padStart(2, '0')}`;
    }
  }

  return result;
}

/**
 * Authenticate MIFARE Classic block
 */
export async function authenticate(
  device: NfcDevice,
  blockNumber: number,
  keyType: 'A' | 'B' = 'A',
  keyNumber: number = 0
): Promise<NfcCommandResult> {
  const kt = keyType === 'A' ? 0x60 : 0x61;
  const apdu = new Uint8Array([0xff, 0x86, 0x00, 0x00, 0x05, 0x01, 0x00, blockNumber, kt, keyNumber]);
  const result = await sendApdu(device, apdu);

  if (result.success && result.data && result.data.length >= 2) {
    const sw1 = result.data[result.data.length - 2];
    const sw2 = result.data[result.data.length - 1];

    if (sw1 === 0x90 && sw2 === 0x00) {
      result.message = `Authenticated block ${blockNumber} with key ${keyType}`;
    } else {
      result.success = false;
      result.message = `Authentication failed: SW=${sw1.toString(16).padStart(2, '0')}${sw2.toString(16).padStart(2, '0')}`;
    }
  }

  return result;
}

/**
 * Read MIFARE Classic block
 */
export async function readBlock(
  device: NfcDevice,
  blockNumber: number,
  length: number = 16
): Promise<NfcCommandResult> {
  const apdu = new Uint8Array([0xff, 0xb0, 0x00, blockNumber & 0xff, length & 0xff]);
  const result = await sendApdu(device, apdu);

  if (result.success && result.data && result.data.length >= 2) {
    const sw1 = result.data[result.data.length - 2];
    const sw2 = result.data[result.data.length - 1];

    if (sw1 === 0x90 && sw2 === 0x00) {
      const data = result.data.subarray(0, result.data.length - 2);
      return {
        success: true,
        data: data,
        hexData: toHex(data),
        message: `Block ${blockNumber}: ${toHex(data)}`,
      };
    } else {
      result.success = false;
      result.message = `Read failed: SW=${sw1.toString(16).padStart(2, '0')}${sw2.toString(16).padStart(2, '0')}`;
    }
  }

  return result;
}

/**
 * Send custom APDU command
 */
export async function sendCustomApdu(
  device: NfcDevice,
  hexCommand: string
): Promise<NfcCommandResult> {
  try {
    const apdu = fromHex(hexCommand);
    return await sendApdu(device, apdu);
  } catch (error) {
    return {
      success: false,
      message: `Invalid hex command: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// Re-export utilities
export { toHex, fromHex };
