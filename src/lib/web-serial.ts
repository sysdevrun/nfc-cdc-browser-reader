/**
 * Web Serial API interface for NFC readers in CDC/Serial mode
 */

export type SerialLogCallback = (direction: 'TX' | 'RX' | 'INFO', data: string) => void;

let logCallback: SerialLogCallback | null = null;

export function setSerialLogCallback(callback: SerialLogCallback | null): void {
  logCallback = callback;
}

function log(direction: 'TX' | 'RX' | 'INFO', data: string): void {
  if (logCallback) {
    logCallback(direction, data);
  }
  const prefix = direction === 'TX' ? '→ TX:' : direction === 'RX' ? '← RX:' : 'ℹ INFO:';
  console.log(`[Serial] ${prefix} ${data}`);
}

export interface SerialDevice {
  port: SerialPort;
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
  writer: WritableStreamDefaultWriter<Uint8Array> | null;
  pendingRead?: Promise<ReadableStreamReadResult<Uint8Array>>;
}

export interface SerialConnectionResult {
  success: boolean;
  device?: SerialDevice;
  error?: string;
}

export const KNOWN_SERIAL_NFC_READERS = [
  { usbVendorId: 0x1fd3, usbProductId: 0x0108 }, // ASK RDR-518
  { usbVendorId: 0x072f }, // ACS readers
  { usbVendorId: 0x1a86 }, // CH340
  { usbVendorId: 0x0403 }, // FTDI
  { usbVendorId: 0x10c4 }, // Silicon Labs CP210x
  { usbVendorId: 0x067b }, // Prolific PL2303
];

export function isWebSerialSupported(): boolean {
  return 'serial' in navigator;
}

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
      return { success: false, error: 'No serial port selected.' };
    }
    return {
      success: false,
      error: `Failed to request port: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

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
      device: { port, reader, writer },
    };
  } catch (error) {
    log('INFO', `Connection failed: ${error instanceof Error ? error.message : String(error)}`);
    return {
      success: false,
      error: `Failed to open port: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

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
  }
}

/**
 * Send command and receive response.
 */
export async function transceiveSerial(
  device: SerialDevice,
  command: Uint8Array,
  timeout: number = 2000
): Promise<Uint8Array> {
  if (!device.reader || !device.writer) {
    throw new Error('Serial port not ready');
  }

  // Consume any pending read from previous timeout
  if (device.pendingRead) {
    try {
      const stale = await Promise.race([
        device.pendingRead,
        new Promise<null>(r => setTimeout(() => r(null), 50))
      ]);
      if (stale && stale.value) {
        log('RX', `Stale (${stale.value.length} bytes): ${toHexSerial(stale.value)}`);
      }
    } catch {
      // Ignore errors from stale read
    }
    device.pendingRead = undefined;
  }

  // Send command
  log('TX', `Command (${command.length} bytes): ${toHexSerial(command)}`);
  await device.writer.write(command);

  // Read response
  let response = await readWithTimeout(device, timeout);
  log('RX', `Response (${response.length} bytes): ${toHexSerial(response)}`);

  // Strip leading DLE bytes (0x10) - device sends these on first command after connect
  while (response.length > 0 && response[0] === 0x10) {
    log('INFO', 'Stripping DLE byte (0x10)');
    response = response.slice(1);
  }

  // Handle ACK prefix (0x01)
  if (response.length > 1 && response[0] === 0x01) {
    return response.slice(1);
  }

  return response;
}

/**
 * Read with timeout. Tracks pending read to avoid orphaning.
 */
async function readWithTimeout(
  device: SerialDevice,
  timeout: number
): Promise<Uint8Array> {
  if (!device.reader) {
    throw new Error('Serial port reader not available');
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const remaining = timeout - (Date.now() - startTime);
    if (remaining <= 0) break;

    // Start read
    const readPromise = device.reader.read();
    const timeoutPromise = new Promise<'timeout'>(resolve =>
      setTimeout(() => resolve('timeout'), remaining)
    );

    const result = await Promise.race([readPromise, timeoutPromise]);

    if (result === 'timeout') {
      // Store the pending read for later consumption
      device.pendingRead = readPromise;
      log('INFO', 'Read timeout');
      break;
    }

    if (result.done) {
      log('INFO', 'Stream closed');
      break;
    }

    if (result.value && result.value.length > 0) {
      chunks.push(result.value);
      totalBytes += result.value.length;
      log('RX', `Chunk (${result.value.length} bytes): ${toHexSerial(result.value)}`);

      const combined = combineChunks(chunks, totalBytes);
      if (isCompleteFrame(combined)) {
        return combined;
      }
    }
  }

  return combineChunks(chunks, totalBytes);
}

function combineChunks(chunks: Uint8Array[], totalLength: number): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0];

  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/**
 * Check if we have a complete frame.
 */
function isCompleteFrame(data: Uint8Array): boolean {
  if (data.length < 4) return false;

  // Skip leading DLE bytes (0x10) - device sends these on first command after connect
  let offset = 0;
  while (offset < data.length && data[offset] === 0x10) {
    offset++;
  }
  if (offset > 0) {
    return isCompleteFrame(data.slice(offset));
  }

  const len = data[0];

  // ACK responses
  if (data.length === 1 && data[0] === 0x01) return true;
  if (data[0] === 0x01 && data.length > 1) {
    return isCompleteFrame(data.slice(1));
  }

  // Known frame sizes
  if (len === 0x04 && data.length >= 8) return true;
  if (len === 0x0b && data.length >= 15) return true;

  // Generic check
  if (data.length >= len + 4) return true;

  return false;
}

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

export function toHexSerial(data: Uint8Array): string {
  return Array.from(data)
    .map(b => b.toString(16).padStart(2, '0').toUpperCase())
    .join(' ');
}

export function fromHexSerial(hex: string): Uint8Array {
  const cleanHex = hex.replace(/\s+/g, '');
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleanHex.substr(i * 2, 2), 16);
  }
  return bytes;
}
