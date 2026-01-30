/**
 * NFC Device interface using Web Serial
 * Protocol specific to ASK CSC (RDR-518) NFC Reader
 */

import { SerialDevice, transceiveSerial } from './web-serial';

export interface NfcDevice {
  type: 'serial';
  name: string;
  serialDevice: SerialDevice;
}

export interface NfcCommandResult {
  success: boolean;
  data?: Uint8Array;
  message: string;
  hexData?: string;
  atqa?: string;
  sak?: string;
  comType?: number;
}

export interface NfcVersionInfo {
  raw: string;
  model?: string;
  type?: string;
  version?: string;
  interface?: string;
  buildDate?: string;
  buildTime?: string;
  manufacturer: string;
}

// ASK CSC Protocol Constants
const CMD_EXECUTE = 0x80;

// Function Classes
const CLASS_SYSTEM = 0x01;

// System Commands
const SYS_SOFTWARE_VERSION = 0x01;
const SYS_ENTER_HUNT_PHASE = 0x03;
const SYS_END_TAG_COMMUNICATION = 0x04;
const SYS_SWITCH_SIGNALS = 0x18;

// Communication Types
export const COM_TYPE = {
  CONTACT: 0x01,
  ISOB: 0x02,
  ISOA: 0x04,
  ISOA_EXTENDED: 0x05,
  MIFARE: 0x08,
  INNOVATRON: 0x10,
} as const;

// LED/Buzzer Control Constants
export const LED = {
  ANT_BUZZER: 0x0001,
  ANT_LED1: 0x0002,
  ANT_LED2: 0x0004,
  CPU_LED1: 0x0100,
  CPU_LED2: 0x0200,
  CPU_LED3: 0x0400,
} as const;

/**
 * Calculate CRC-16 CCITT checksum
 * Polynomial: 0x1021, Initial: 0xFFFF, No reflection
 */
export function crc16Ccitt(data: Uint8Array): number {
  let crc = 0xFFFF;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      if (crc & 0x8000) {
        crc = (crc << 1) ^ 0x1021;
      } else {
        crc <<= 1;
      }
      crc &= 0xFFFF;
    }
  }
  return crc;
}

/**
 * Build a complete command frame with CRC
 */
export function buildCommand(
  cmd: number,
  classId: number,
  ident: number,
  data: Uint8Array = new Uint8Array(0)
): Uint8Array {
  const length = 2 + data.length; // CLASS + IDENT + DATA
  const frame = new Uint8Array(4 + data.length);
  frame[0] = cmd;
  frame[1] = length;
  frame[2] = classId;
  frame[3] = ident;
  frame.set(data, 4);

  const crc = crc16Ccitt(frame);
  const result = new Uint8Array(frame.length + 2);
  result.set(frame);
  result[frame.length] = crc & 0xFF; // Low byte
  result[frame.length + 1] = (crc >> 8) & 0xFF; // High byte

  return result;
}

/**
 * Build card hunt (Enter Hunt Phase) command
 * Based on working command: 80 0A 01 03 00 00 02 11 03 01 01 14 00 9C F8
 *
 * This is CSC_SearchCardExt with extended parameters for ISO-A and MIFARE detection.
 */
export function buildHuntCommand(options: {
  isoa?: boolean;
  isob?: boolean;
  mifare?: boolean;
  forget?: boolean;
  timeout10ms?: number;
  antenna?: number;
} = {}): Uint8Array {
  const {
    isoa = true,
    isob = false,
    mifare = true,
    forget = true,
    timeout10ms = 0x14, // 200ms default
    antenna = 2,        // Antenna number (1-4)
  } = options;

  // Data structure (CSC_SearchCardExt - 9 bytes):
  // Byte 0: CONT    - Contact mode (0x00 = disabled)
  // Byte 1: ISOB    - ISO 14443-B (0x00 = disabled, 0x01-0x04 = antenna number)
  // Byte 2: ISOA    - ISO 14443-A (0x00 = disabled, 0x01-0x04 = antenna number)
  // Byte 3: CONFIG  - Protocol config (0x11 = ISO-A + extended ATR mode)
  // Byte 4: MIFARE  - MIFARE detection (0x00 = disabled, 0x03 = enabled)
  // Byte 5: FLAGS   - Search flags (0x01 = additional flags)
  // Byte 6: FORGET  - Forget previous card (0x00 = remember, 0x01 = forget)
  // Byte 7: TIMEOUT - Search timeout (value × 10ms)
  // Byte 8: RFU     - Reserved (0x00)
  const data = new Uint8Array([
    0x00,                               // CONT: disabled
    isob ? antenna : 0x00,              // ISOB: antenna number or disabled
    isoa ? antenna : 0x00,              // ISOA: antenna number or disabled
    0x11,                               // CONFIG: 0x11 (ISO-A + extended ATR)
    mifare ? 0x03 : 0x00,               // MIFARE: 0x03 = enabled
    0x01,                               // FLAGS: 0x01 (search flags)
    forget ? 0x01 : 0x00,               // FORGET: forget previous card
    timeout10ms,                        // TIMEOUT: x10ms
    0x00,                               // RFU: reserved
  ]);

  return buildCommand(CMD_EXECUTE, CLASS_SYSTEM, SYS_ENTER_HUNT_PHASE, data);
}

/**
 * Build LED/Buzzer control command
 */
export function buildLedCommand(param: number): Uint8Array {
  const data = new Uint8Array([param & 0xFF, (param >> 8) & 0xFF]);
  return buildCommand(CMD_EXECUTE, CLASS_SYSTEM, SYS_SWITCH_SIGNALS, data);
}

/**
 * Build get software version command
 */
export function buildGetVersionCommand(): Uint8Array {
  return buildCommand(CMD_EXECUTE, CLASS_SYSTEM, SYS_SOFTWARE_VERSION);
}

/**
 * Build end tag communication command
 * @param disconnect - true to disconnect card, false to keep in field
 */
export function buildEndTagCommand(disconnect: boolean = true): Uint8Array {
  const data = new Uint8Array([disconnect ? 0x01 : 0x00]);
  return buildCommand(CMD_EXECUTE, CLASS_SYSTEM, SYS_END_TAG_COMMUNICATION, data);
}

/**
 * Parse software version response
 */
export function parseVersionResponse(response: Uint8Array): NfcVersionInfo | null {
  if (response.length < 6) {
    return null;
  }

  // Version string starts at byte 3, ends before CRC (last 2 bytes)
  const versionBytes = response.subarray(3, response.length - 2);

  // Decode as ASCII, remove null terminators
  const raw = Array.from(versionBytes)
    .map(b => b === 0 ? '' : String.fromCharCode(b))
    .join('')
    .trim();

  // Parse components: "GEN5XX CSC 01.20<USB> Jul 31 2014 16:16:21 (C) ASK  SAM?"
  const parts = raw.split(/\s+/);

  return {
    raw,
    model: parts[0] || undefined,
    type: parts[1] || undefined,
    version: parts[2] || undefined,
    interface: parts[3]?.replace(/[<>]/g, '') || undefined,
    buildDate: parts.length > 6 ? `${parts[4]} ${parts[5]} ${parts[6]}` : undefined,
    buildTime: parts[7] || undefined,
    manufacturer: 'ASK',
  };
}

/**
 * Parse card hunt response
 */
export function parseHuntResponse(response: Uint8Array): NfcCommandResult {
  if (response.length < 4) {
    return {
      success: false,
      message: 'Response too short',
      data: response,
      hexData: toHex(response),
    };
  }

  const len = response[0];

  // Check for "no card" response: LEN <= 4
  if (len <= 4 && response.length >= 6) {
    const errorCode = response[4];
    if (errorCode === 0x6f) {
      return {
        success: false,
        data: response,
        hexData: toHex(response),
        message: 'No card in field',
      };
    }
    return {
      success: false,
      data: response,
      hexData: toHex(response),
      message: `Reader error: 0x${errorCode.toString(16).padStart(2, '0')}`,
    };
  }

  // Check for "card found" response
  if (len >= 0x07 && response.length >= len + 4) {
    // Response format:
    // [0] = LEN
    // [1-3] = CLASS, IDENT, STATUS
    // [4] = COM type (0x05 = ISO-A, 0x08 = MIFARE, etc.)
    // [5] = ATR length indicator
    // [6] = 00
    // [7] = SAK (or UID length for extended)
    // [8-11] = UID (4 bytes for standard)
    // [12] = Status byte
    // [13-14] = CRC-16

    const comType = response[4];

    // For ISO-A/MIFARE cards, UID is typically at offset 8
    if (response.length >= 13) {
      const atqa = response.subarray(4, 6);
      const sak = response[7];
      const uid = response.subarray(8, 12);
      const statusByte = response.length >= 13 ? response[12] : 0;

      if (statusByte === 0x00 || len === 0x0b) {
        return {
          success: true,
          data: uid,
          hexData: toHex(uid),
          atqa: toHex(atqa),
          sak: sak.toString(16).padStart(2, '0').toUpperCase(),
          comType: comType,
          message: `Card found! UID: ${toHex(uid)}`,
        };
      }
    }
  }

  // Unknown response format but contains data
  return {
    success: false,
    data: response,
    hexData: toHex(response),
    message: `Unknown response (LEN=0x${len.toString(16)})`,
  };
}

/**
 * Send raw bytes to the device and get response
 */
export async function transceive(
  device: NfcDevice,
  command: Uint8Array,
  timeout: number = 2000
): Promise<Uint8Array> {
  if (device.serialDevice) {
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
 * Card Hunt - Search for cards in the RF field
 */
export async function cardHunt(
  device: NfcDevice,
  options: {
    isoa?: boolean;
    isob?: boolean;
    mifare?: boolean;
    forget?: boolean;
    timeout10ms?: number;
    antenna?: number;
  } = {}
): Promise<NfcCommandResult> {
  const command = buildHuntCommand(options);
  const result = await sendCommand(device, command);

  if (result.success && result.data) {
    return parseHuntResponse(result.data);
  }

  return result;
}

/**
 * Get card UID using card hunt
 */
export async function getCardUid(device: NfcDevice): Promise<NfcCommandResult> {
  return await cardHunt(device, {
    isoa: true,
    isob: false,
    forget: true,
    timeout10ms: 0x14, // 200ms for quick polling
  });
}

/**
 * Control LEDs and buzzer
 */
export async function setLeds(device: NfcDevice, param: number): Promise<boolean> {
  const command = buildLedCommand(param);
  const result = await sendCommand(device, command);
  return result.success && !!result.data && result.data.length >= 4 && result.data[3] === 0x00;
}

/**
 * Get firmware version from reader
 */
export async function getFirmwareVersion(device: NfcDevice): Promise<{ success: boolean; version?: NfcVersionInfo; message: string; hexData?: string }> {
  const command = buildGetVersionCommand();
  const result = await sendCommand(device, command);

  if (result.success && result.data) {
    const version = parseVersionResponse(result.data);
    if (version) {
      return {
        success: true,
        version,
        message: `${version.model} ${version.type} v${version.version}`,
        hexData: result.hexData,
      };
    }
  }

  return {
    success: false,
    message: result.message || 'Failed to get firmware version',
    hexData: result.hexData,
  };
}

/**
 * End tag communication (disconnect card)
 */
export async function endTagCommunication(device: NfcDevice, disconnect: boolean = true): Promise<NfcCommandResult> {
  const command = buildEndTagCommand(disconnect);
  const result = await sendCommand(device, command);

  if (result.success && result.data && result.data.length >= 4) {
    const status = result.data[3];
    return {
      success: status === 0x01,
      data: result.data,
      hexData: result.hexData,
      message: status === 0x01 ? 'Card disconnected' : `End tag failed: status=0x${status.toString(16)}`,
    };
  }

  return result;
}

/**
 * Beep and flash LED on success
 */
export async function beepSuccess(device: NfcDevice): Promise<void> {
  await setLeds(device, LED.CPU_LED1 | LED.ANT_BUZZER);
  await new Promise(resolve => setTimeout(resolve, 100));
  await setLeds(device, LED.CPU_LED1);
  await new Promise(resolve => setTimeout(resolve, 100));
  await setLeds(device, 0x0000);
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
