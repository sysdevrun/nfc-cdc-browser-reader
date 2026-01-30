/**
 * Web Serial API interface for NFC readers in CDC/Serial mode
 *
 * This is the preferred method for Windows as WebUSB cannot access
 * devices claimed by the USB Serial driver (usbser.sys).
 *
 * ASK RDR-518 Protocol Flow:
 * 1. Host sends command
 * 2. Reader responds with ACK (0x01) indicating "processing"
 * 3. Host sends empty message to poll for result
 * 4. Reader responds with actual payload
 */

// Logging callback type for external logging
export type SerialLogCallback = (direction: 'TX' | 'RX' | 'INFO', data: string) => void;

// Global log callback - can be set by the application
let logCallback: SerialLogCallback | null = null;

export function setSerialLogCallback(callback: SerialLogCallback | null): void {
  logCallback = callback;
}

function log(direction: 'TX' | 'RX' | 'INFO', data: string): void {
  if (logCallback) {
    logCallback(direction, data);
  }
  // Always log to console for debugging
  const prefix = direction === 'TX' ? '→ TX:' : direction === 'RX' ? '← RX:' : 'ℹ INFO:';
  console.log(`[Serial] ${prefix} ${data}`);
}

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
    log('INFO', 'Opening serial port at 115200 baud...');
    await port.open({
      baudRate: 115200,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'none',
    });

    const writer = port.writable?.getWriter() || null;
    const reader = port.readable?.getReader() || null;

    const info = port.getInfo();
    log('INFO', `Connected to ${info.usbVendorId?.toString(16)}:${info.usbProductId?.toString(16)}`);

    return {
      success: true,
      device: {
        port,
        reader,
        writer,
      },
    };
  } catch (error) {
    log('INFO', `Connection failed: ${error instanceof Error ? error.message : String(error)}`);
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
  log('INFO', 'Disconnecting serial port...');
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
    log('INFO', 'Serial port disconnected');
  } catch (error) {
    log('INFO', `Error disconnecting: ${error instanceof Error ? error.message : String(error)}`);
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
 * For ASK RDR-518: Uses multi-step protocol:
 * 1. Send command
 * 2. Wait for response (may be ACK 0x01 or full response)
 * 3. If ACK, send empty poll and wait for actual payload
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
  log('INFO', 'Clearing serial buffer...');
  await clearSerialBuffer(device);

  // Step 1: Send the command
  log('TX', `Command (${command.length} bytes): ${toHexSerial(command)}`);
  await sendSerialData(device, command);

  // Give USB stack time to process and reader to respond
  // The old code that "sometimes worked" used 150ms delay
  await new Promise(resolve => setTimeout(resolve, 150));

  // Step 2: Read response with a simple blocking read
  log('INFO', 'Reading response...');
  const response = await simpleRead(device, timeout);
  log('RX', `Response (${response.length} bytes): ${toHexSerial(response)}`);

  // Check if this is an ACK (0x01) requiring us to poll for the actual response
  if (response.length === 1 && response[0] === 0x01) {
    log('INFO', 'Received ACK (0x01), sending empty poll message...');

    // Step 3: Send empty message to poll for actual response
    await sendSerialData(device, new Uint8Array(0));
    log('TX', 'Poll (empty)');

    // Wait and read payload
    await new Promise(resolve => setTimeout(resolve, 100));
    const payload = await simpleRead(device, timeout);
    log('RX', `Payload (${payload.length} bytes): ${toHexSerial(payload)}`);

    return payload;
  }

  // If we got data, check if it's a complete frame
  if (response.length > 0 && isCompleteFrame(response)) {
    log('INFO', 'Received complete frame');
    return response;
  }

  // Return whatever we got
  return response;
}

/**
 * Simple read - just wait for data without complex timeout racing
 * This avoids the issue where Promise.race loses data
 */
async function simpleRead(
  device: SerialDevice,
  timeout: number
): Promise<Uint8Array> {
  if (!device.reader) {
    throw new Error('Serial port reader not available');
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const startTime = Date.now();

  // Try to read, giving generous time for data to arrive
  while (Date.now() - startTime < timeout) {
    try {
      // Use AbortController for clean timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 500);

      try {
        const result = await device.reader.read();
        clearTimeout(timeoutId);

        if (result.done) {
          log('INFO', 'Reader done');
          break;
        }

        if (result.value && result.value.length > 0) {
          chunks.push(result.value);
          totalBytes += result.value.length;
          log('RX', `Chunk (${result.value.length} bytes): ${toHexSerial(result.value)}`);

          // Check if we have enough data
          const combined = combineChunks(chunks, totalBytes);

          // Single byte (likely ACK)
          if (combined.length === 1) {
            return combined;
          }

          // Complete frame
          if (isCompleteFrame(combined)) {
            return combined;
          }

          // Wait a bit for more data
          await new Promise(resolve => setTimeout(resolve, 50));
          continue;
        }
      } catch (e) {
        clearTimeout(timeoutId);
        // Read was aborted or failed
        if (totalBytes > 0) {
          break; // Return what we have
        }
        // No data yet, try again
      }
    } catch (error) {
      log('INFO', `Read error: ${error instanceof Error ? error.message : String(error)}`);
      break;
    }
  }

  return combineChunks(chunks, totalBytes);
}

/**
 * Clear any stale data from the serial buffer
 */
async function clearSerialBuffer(device: SerialDevice): Promise<void> {
  if (!device.reader) return;

  const startTime = Date.now();
  let clearedBytes = 0;
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
      // Log discarded stale data
      log('RX', `Stale data cleared: ${toHexSerial(result.value)}`);
      clearedBytes += result.value.length;
    } catch {
      break;
    }
  }
  if (clearedBytes > 0) {
    log('INFO', `Cleared ${clearedBytes} stale bytes from buffer`);
  }
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
 * Frame structure: [LEN][CLASS][IDENT][STATUS][DATA...][CRC-16]
 * Total expected = LEN + 2 (for the LEN byte itself and trailing bytes) + 2 (CRC)
 */
function isCompleteFrame(data: Uint8Array): boolean {
  if (data.length < 4) return false;

  const len = data[0];

  // Known frame sizes for ASK RDR-518:
  // LEN=0x04: no-card response, total 8 bytes (LEN + 4 data + 2 CRC + 1)
  // LEN=0x0b: card-found response, total 15 bytes
  if (len === 0x04 && data.length >= 8) return true;
  if (len === 0x0b && data.length >= 15) return true;

  // Generic check: LEN value + 4 bytes (for LEN byte + some header + CRC)
  // The LEN field typically indicates payload size after the header
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
