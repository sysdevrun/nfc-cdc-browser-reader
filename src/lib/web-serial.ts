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
  { usbVendorId: 0x1fd3, usbProductId: 0x0108 }, // RDR-518 NFC Reader
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
 * Receive data from serial port with timeout
 */
export async function receiveSerialData(
  device: SerialDevice,
  timeout: number = 2000
): Promise<Uint8Array> {
  if (!device.reader) {
    throw new Error('Serial port reader not available');
  }

  const chunks: Uint8Array[] = [];
  const startTime = Date.now();

  try {
    while (Date.now() - startTime < timeout) {
      const readPromise = device.reader.read();
      const timeoutPromise = new Promise<{ value: undefined; done: true }>((resolve) =>
        setTimeout(() => resolve({ value: undefined, done: true }), Math.max(100, timeout - (Date.now() - startTime)))
      );

      const result = await Promise.race([readPromise, timeoutPromise]);

      if (result.done) {
        break;
      }

      if (result.value && result.value.length > 0) {
        chunks.push(result.value);
        // If we received data, wait a bit more for additional data
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
  } catch (error) {
    console.error('Read error:', error);
  }

  // Combine all chunks
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}

/**
 * Send command and receive response
 */
export async function transceiveSerial(
  device: SerialDevice,
  command: Uint8Array,
  timeout: number = 2000
): Promise<Uint8Array> {
  // Clear any pending data first
  if (device.reader) {
    try {
      // Quick read to clear buffer
      const clearPromise = device.reader.read();
      const quickTimeout = new Promise<{ done: true }>((resolve) =>
        setTimeout(() => resolve({ done: true }), 50)
      );
      await Promise.race([clearPromise, quickTimeout]);
    } catch {
      // Ignore clear errors
    }
  }

  await sendSerialData(device, command);

  // Small delay to allow device to process
  await new Promise(resolve => setTimeout(resolve, 50));

  return await receiveSerialData(device, timeout);
}

/**
 * Get serial port info
 */
export function getSerialPortInfo(port: SerialPort): string {
  const info = port.getInfo();

  if (info.usbVendorId === 0x1fd3 && info.usbProductId === 0x0108) {
    return 'RDR-518 NFC Reader';
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
