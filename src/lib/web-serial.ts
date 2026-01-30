/**
 * Web Serial API interface for NFC readers in CDC/Serial mode
 *
 * This is the preferred method for Windows as WebUSB cannot access
 * devices claimed by the USB Serial driver (usbser.sys).
 */

export interface SerialDevice {
  port: SerialPort;
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
  writer: WritableStreamDefaultWriter<Uint8Array> | null;
}

export interface SerialConnectionResult {
  success: boolean;
  device?: SerialDevice;
  error?: string;
}

// Known NFC reader USB vendor/product IDs for serial filter
export const KNOWN_SERIAL_NFC_READERS = [
  { usbVendorId: 0x1fd3, usbProductId: 0x0108 }, // ASK RDR-518
  { usbVendorId: 0x072f }, // ACS readers
  { usbVendorId: 0x1a86 }, // CH340
  { usbVendorId: 0x0403 }, // FTDI
  { usbVendorId: 0x10c4 }, // Silicon Labs CP210x
  { usbVendorId: 0x067b }, // Prolific PL2303
];

/**
 * Check if Web Serial API is supported
 */
export function isWebSerialSupported(): boolean {
  return 'serial' in navigator;
}

/**
 * Request a serial port from the user
 */
export async function requestSerialPort(): Promise<SerialConnectionResult> {
  if (!isWebSerialSupported()) {
    return {
      success: false,
      error: 'Web Serial API is not supported in this browser. Please use Chrome or Edge.',
    };
  }

  try {
    const port = await navigator.serial.requestPort({
      filters: KNOWN_SERIAL_NFC_READERS,
    });

    return await connectSerialPort(port);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') {
      return {
        success: false,
        error: 'No serial port selected.',
      };
    }
    return {
      success: false,
      error: `Failed to request port: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Connect to a serial port
 */
export async function connectSerialPort(port: SerialPort): Promise<SerialConnectionResult> {
  try {
    await port.open({
      baudRate: 115200,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'none',
    });

    const writer = port.writable?.getWriter() || null;
    const reader = port.readable?.getReader() || null;

    return {
      success: true,
      device: {
        port,
        reader,
        writer,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to open port: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Disconnect from serial port
 */
export async function disconnectSerialPort(device: SerialDevice): Promise<void> {
  try {
    if (device.reader) {
      await device.reader.cancel();
      device.reader.releaseLock();
    }
    if (device.writer) {
      await device.writer.close();
      device.writer.releaseLock();
    }
    await device.port.close();
  } catch (error) {
    console.error('Error disconnecting serial port:', error);
  }
}

/**
 * Send data over serial port
 */
export async function sendSerialData(device: SerialDevice, data: Uint8Array): Promise<void> {
  if (!device.writer) {
    throw new Error('Serial port writer not available');
  }
  await device.writer.write(data);
}

/**
 * Send command and receive response
 * For ASK RDR-518: response format is [LEN] [DATA...] [CRC-16]
 */
export async function transceiveSerial(
  device: SerialDevice,
  command: Uint8Array,
  timeout: number = 2000
): Promise<Uint8Array> {
  if (!device.reader || !device.writer) {
    throw new Error('Serial port not ready');
  }

  // Clear any stale data in the buffer first
  await clearSerialBuffer(device);

  // Send the command
  await sendSerialData(device, command);

  // Wait for device to process command and perform RF operation
  await new Promise(resolve => setTimeout(resolve, 150));

  // Read response, looking for a complete frame
  return await receiveSerialFrame(device, timeout);
}

/**
 * Clear any stale data from the serial buffer
 */
async function clearSerialBuffer(device: SerialDevice): Promise<void> {
  if (!device.reader) return;

  const startTime = Date.now();
  while (Date.now() - startTime < 100) {
    try {
      const readPromise = device.reader.read();
      const timeoutPromise = new Promise<{ value: undefined; done: true }>((resolve) =>
        setTimeout(() => resolve({ value: undefined, done: true }), 20)
      );
      const result = await Promise.race([readPromise, timeoutPromise]);
      if (result.done || !result.value || result.value.length === 0) {
        break; // Buffer is empty
      }
      // Discard stale data and continue clearing
    } catch {
      break;
    }
  }
}

/**
 * Receive a complete frame from serial port
 * Frame format: [LEN] [DATA...] [CRC-16]
 * LEN=0x04 for no-card (8 bytes total), LEN=0x0b for card-found (15 bytes total)
 */
async function receiveSerialFrame(
  device: SerialDevice,
  timeout: number
): Promise<Uint8Array> {
  if (!device.reader) {
    throw new Error('Serial port reader not available');
  }

  const chunks: Uint8Array[] = [];
  const startTime = Date.now();
  let totalBytes = 0;

  while (Date.now() - startTime < timeout) {
    const remainingTime = Math.max(50, timeout - (Date.now() - startTime));

    const readPromise = device.reader.read();
    const timeoutPromise = new Promise<{ value: undefined; done: true }>((resolve) =>
      setTimeout(() => resolve({ value: undefined, done: true }), Math.min(300, remainingTime))
    );

    const result = await Promise.race([readPromise, timeoutPromise]);

    if (result.value && result.value.length > 0) {
      chunks.push(result.value);
      totalBytes += result.value.length;

      // Check if we have a complete frame
      const combined = combineChunks(chunks, totalBytes);
      if (isCompleteFrame(combined)) {
        return combined;
      }
    } else if (result.done) {
      // Timeout on this read, but keep trying if we don't have data yet
      if (totalBytes > 0) {
        // We have some data, wait a bit more then check
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
  }

  // Return whatever we got
  return combineChunks(chunks, totalBytes);
}

/**
 * Helper to combine chunks into a single Uint8Array
 */
function combineChunks(chunks: Uint8Array[], totalLength: number): Uint8Array {
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/**
 * Check if we have a complete frame based on LEN byte
 */
function isCompleteFrame(data: Uint8Array): boolean {
  if (data.length < 4) return false;

  const len = data[0];

  // Known frame sizes for ASK RDR-518:
  // LEN=0x04: no-card response, total 8 bytes (4 + 2 data + 2 CRC)
  // LEN=0x0b: card-found response, total 15 bytes
  if (len === 0x04 && data.length >= 8) return true;
  if (len === 0x0b && data.length >= 15) return true;

  // Generic check: LEN + 4 bytes (header estimate)
  if (data.length >= len + 4) return true;

  return false;
}

/**
 * Get serial port info
 */
export function getSerialPortInfo(port: SerialPort): string {
  const info = port.getInfo();

  if (info.usbVendorId === 0x1fd3 && info.usbProductId === 0x0108) {
    return 'ASK RDR-518';
  }
  if (info.usbVendorId === 0x072f) {
    return 'ACS NFC Reader';
  }

  if (info.usbVendorId && info.usbProductId) {
    return `Serial Device (${info.usbVendorId.toString(16)}:${info.usbProductId.toString(16)})`;
  }

  return 'Serial Port';
}

/**
 * Convert byte array to hex string
 */
export function toHexSerial(data: Uint8Array): string {
  return Array.from(data)
    .map(b => b.toString(16).padStart(2, '0').toUpperCase())
    .join(' ');
}

/**
 * Convert hex string to byte array
 */
export function fromHexSerial(hex: string): Uint8Array {
  const cleanHex = hex.replace(/\s+/g, '');
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleanHex.substr(i * 2, 2), 16);
  }
  return bytes;
}
