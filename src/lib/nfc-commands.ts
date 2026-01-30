/**
 * NFC Reader Commands for ACS ACR1281S-C1 (ACR518) and similar readers
 *
 * The ACR518 in CDC mode uses a framing protocol for commands.
 * Protocol structure:
 * - STX (0x02) - Start of transmission
 * - LEN (2 bytes, big-endian) - Length of data
 * - DATA - Command data
 * - ETX (0x03) - End of transmission
 * - LRC - XOR checksum of all bytes from STX to ETX
 *
 * For direct APDU transmission (pseudo-APDU via escape commands):
 * CLA=FF is used for reader-specific commands
 */

import { UsbCdcDevice, transceive, toHex, fromHex } from './usb-cdc';

export interface NfcCommandResult {
  success: boolean;
  data?: Uint8Array;
  message: string;
  hexData?: string;
}

// Frame markers
const STX = 0x02;
const ETX = 0x03;

/**
 * Calculate LRC (XOR) checksum
 */
function calculateLrc(data: Uint8Array): number {
  let lrc = 0;
  for (const byte of data) {
    lrc ^= byte;
  }
  return lrc;
}

/**
 * Build framed command for ACR readers in CDC mode
 */
function buildFrame(data: Uint8Array): Uint8Array {
  const len = data.length;
  const frame = new Uint8Array(len + 5); // STX + LEN(2) + DATA + ETX + LRC

  frame[0] = STX;
  frame[1] = (len >> 8) & 0xff;
  frame[2] = len & 0xff;
  frame.set(data, 3);
  frame[3 + len] = ETX;

  // Calculate LRC over STX through ETX
  frame[4 + len] = calculateLrc(frame.subarray(0, 4 + len));

  return frame;
}

/**
 * Parse framed response from ACR readers
 */
function parseFrame(response: Uint8Array): { success: boolean; data: Uint8Array; error?: string } {
  if (response.length < 5) {
    // Response might not be framed, return as-is
    return { success: true, data: response };
  }

  // Check for framed response
  if (response[0] === STX) {
    const len = (response[1] << 8) | response[2];
    if (response.length >= len + 5) {
      const data = response.subarray(3, 3 + len);
      const etxPos = 3 + len;
      if (response[etxPos] === ETX) {
        const expectedLrc = calculateLrc(response.subarray(0, etxPos + 1));
        if (response[etxPos + 1] === expectedLrc) {
          return { success: true, data };
        }
      }
    }
    return { success: false, data: response, error: 'Invalid frame checksum' };
  }

  // Not framed, return as-is
  return { success: true, data: response };
}

/**
 * Send APDU command to the reader
 * For ACS readers, pseudo-APDUs with CLA=FF are reader commands
 */
export async function sendApdu(
  device: UsbCdcDevice,
  apdu: Uint8Array,
  useFraming: boolean = true
): Promise<NfcCommandResult> {
  try {
    const command = useFraming ? buildFrame(apdu) : apdu;
    const response = await transceive(device, command, 256, 3000);

    if (response.length === 0) {
      return {
        success: false,
        message: 'No response from reader',
      };
    }

    const parsed = useFraming ? parseFrame(response) : { success: true, data: response };

    return {
      success: parsed.success,
      data: parsed.data,
      hexData: toHex(parsed.data),
      message: parsed.error || 'OK',
    };
  } catch (error) {
    return {
      success: false,
      message: `Command failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Get reader firmware version
 * Command: FF 00 48 00 00
 */
export async function getFirmwareVersion(device: UsbCdcDevice): Promise<NfcCommandResult> {
  const apdu = fromHex('FF 00 48 00 00');
  const result = await sendApdu(device, apdu);

  if (result.success && result.data) {
    // Try to decode as ASCII
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
 * Command: FF 00 4A 00 00
 */
export async function getSerialNumber(device: UsbCdcDevice): Promise<NfcCommandResult> {
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
 * Poll for card / Activate card detection
 * Command: FF 00 00 00 04 D4 4A 01 00 (InListPassiveTarget)
 * This uses the PN532 InListPassiveTarget command for 106 kbps Type A
 */
export async function pollCard(device: UsbCdcDevice): Promise<NfcCommandResult> {
  // Direct frame command for PN532-based readers
  // InListPassiveTarget with max 1 target, 106 kbps Type A (ISO14443A)
  const apdu = fromHex('FF 00 00 00 04 D4 4A 01 00');
  const result = await sendApdu(device, apdu);

  if (result.success && result.data && result.data.length > 0) {
    // Check for successful card detection
    // Response format varies by reader, look for UID
    result.message = result.data.length > 2 ? 'Card detected' : 'No card in field';
  }

  return result;
}

/**
 * Get card UID using GET DATA command
 * Standard APDU: FF CA 00 00 00
 */
export async function getCardUid(device: UsbCdcDevice): Promise<NfcCommandResult> {
  const apdu = fromHex('FF CA 00 00 00');
  const result = await sendApdu(device, apdu);

  if (result.success && result.data && result.data.length >= 2) {
    // Last 2 bytes are SW1 SW2
    const sw1 = result.data[result.data.length - 2];
    const sw2 = result.data[result.data.length - 1];

    if (sw1 === 0x90 && sw2 === 0x00) {
      // Success - UID is all bytes except SW1 SW2
      const uid = result.data.subarray(0, result.data.length - 2);
      result.message = `UID: ${toHex(uid)} (${uid.length * 8}-bit)`;
      result.data = uid;
      result.hexData = toHex(uid);
    } else if (sw1 === 0x6a && sw2 === 0x81) {
      result.success = false;
      result.message = 'No card present or function not supported';
    } else {
      result.success = false;
      result.message = `Error: SW=${sw1.toString(16).padStart(2, '0')}${sw2.toString(16).padStart(2, '0')}`;
    }
  }

  return result;
}

/**
 * Get card ATS (Answer To Select) / Historical bytes
 * Command: FF CA 01 00 00
 */
export async function getCardAts(device: UsbCdcDevice): Promise<NfcCommandResult> {
  const apdu = fromHex('FF CA 01 00 00');
  const result = await sendApdu(device, apdu);

  if (result.success && result.data && result.data.length >= 2) {
    const sw1 = result.data[result.data.length - 2];
    const sw2 = result.data[result.data.length - 1];

    if (sw1 === 0x90 && sw2 === 0x00) {
      const ats = result.data.subarray(0, result.data.length - 2);
      result.message = `ATS: ${toHex(ats)}`;
      result.data = ats;
      result.hexData = toHex(ats);
    } else {
      result.success = false;
      result.message = 'No ATS available';
    }
  }

  return result;
}

/**
 * Turn antenna RF field ON
 * Command: FF 00 00 00 04 D4 32 01 01
 */
export async function antennaOn(device: UsbCdcDevice): Promise<NfcCommandResult> {
  // RFConfiguration command to turn on RF field
  const apdu = fromHex('FF 00 00 00 04 D4 32 01 01');
  const result = await sendApdu(device, apdu);
  result.message = result.success ? 'Antenna ON' : 'Failed to turn on antenna';
  return result;
}

/**
 * Turn antenna RF field OFF
 * Command: FF 00 00 00 04 D4 32 01 00
 */
export async function antennaOff(device: UsbCdcDevice): Promise<NfcCommandResult> {
  const apdu = fromHex('FF 00 00 00 04 D4 32 01 00');
  const result = await sendApdu(device, apdu);
  result.message = result.success ? 'Antenna OFF' : 'Failed to turn off antenna';
  return result;
}

/**
 * Control buzzer (ACS readers)
 * Command: FF 00 52 TT 00 where TT is duration in units of 10ms
 */
export async function buzzer(device: UsbCdcDevice, durationMs: number = 100): Promise<NfcCommandResult> {
  const duration = Math.min(255, Math.floor(durationMs / 10));
  const apdu = new Uint8Array([0xff, 0x00, 0x52, duration, 0x00]);
  const result = await sendApdu(device, apdu);
  result.message = result.success ? `Buzzer: ${duration * 10}ms` : 'Buzzer command failed';
  return result;
}

/**
 * Control LED (ACS readers)
 * Command: FF 00 40 LL 04 TT TT BB BB
 * LL = LED state (bit mask)
 * TT TT = T1 T2 duration
 * BB BB = number of blinks
 */
export async function ledControl(
  device: UsbCdcDevice,
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
 * Read MIFARE Classic block
 * Command: FF B0 00 BB LL where BB=block number, LL=length
 */
export async function readBlock(
  device: UsbCdcDevice,
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
      result.message = `Block ${blockNumber}: ${toHex(data)}`;
      result.data = data;
      result.hexData = toHex(data);
    } else {
      result.success = false;
      result.message = `Read failed: SW=${sw1.toString(16).padStart(2, '0')}${sw2.toString(16).padStart(2, '0')}`;
    }
  }

  return result;
}

/**
 * Authenticate MIFARE Classic block with key
 * Command: FF 86 00 00 05 01 00 BB KT KN
 * BB = block number, KT = key type (0x60=A, 0x61=B), KN = key number (stored key)
 */
export async function authenticate(
  device: UsbCdcDevice,
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
 * Load authentication key into reader memory
 * Command: FF 82 00 KN 06 K1 K2 K3 K4 K5 K6
 * KN = key number (0-1), K1-K6 = key bytes
 */
export async function loadKey(
  device: UsbCdcDevice,
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
 * Send custom APDU command
 */
export async function sendCustomApdu(
  device: UsbCdcDevice,
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

/**
 * Send raw bytes without framing (for testing)
 */
export async function sendRawCommand(
  device: UsbCdcDevice,
  hexCommand: string
): Promise<NfcCommandResult> {
  try {
    const data = fromHex(hexCommand);
    const result = await sendApdu(device, data, false);
    return result;
  } catch (error) {
    return {
      success: false,
      message: `Raw command failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Continuous card polling with callback
 */
export async function startPolling(
  device: UsbCdcDevice,
  onCardDetected: (uid: string) => void,
  intervalMs: number = 500
): Promise<() => void> {
  let running = true;
  let lastUid = '';

  const poll = async () => {
    while (running) {
      const result = await getCardUid(device);
      if (result.success && result.hexData) {
        if (result.hexData !== lastUid) {
          lastUid = result.hexData;
          onCardDetected(result.hexData);
        }
      } else {
        lastUid = '';
      }
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  };

  poll();

  return () => {
    running = false;
  };
}

// Command presets for easy access
export const COMMANDS = {
  GET_FIRMWARE: { name: 'Get Firmware Version', fn: getFirmwareVersion },
  GET_SERIAL: { name: 'Get Serial Number', fn: getSerialNumber },
  POLL_CARD: { name: 'Poll for Card', fn: pollCard },
  GET_UID: { name: 'Get Card UID', fn: getCardUid },
  GET_ATS: { name: 'Get Card ATS', fn: getCardAts },
  ANTENNA_ON: { name: 'Antenna ON', fn: antennaOn },
  ANTENNA_OFF: { name: 'Antenna OFF', fn: antennaOff },
  BUZZER: { name: 'Buzzer', fn: (d: UsbCdcDevice) => buzzer(d, 100) },
  LED_RED: { name: 'LED Red', fn: (d: UsbCdcDevice) => ledControl(d, true, false) },
  LED_GREEN: { name: 'LED Green', fn: (d: UsbCdcDevice) => ledControl(d, false, true) },
  LED_OFF: { name: 'LED Off', fn: (d: UsbCdcDevice) => ledControl(d, false, false) },
} as const;
