import { useState, useCallback, useRef } from 'react';
import {
  isWebSerialSupported,
  requestSerialPort,
  disconnectSerialPort,
  getSerialPortInfo,
} from './lib/web-serial';
import {
  isWebUsbSupported,
  requestDevice as requestUsbDevice,
  disconnectDevice as disconnectUsbDevice,
  getDeviceInfo,
} from './lib/usb-cdc';
import {
  NfcDevice,
  NfcCommandResult,
  getFirmwareVersion,
  getSerialNumber,
  getCardUid,
  getCardAts,
  pollCard,
  antennaOn,
  antennaOff,
  buzzer,
  ledControl,
  readBlock,
  authenticate,
  loadKey,
  sendCustomApdu,
  fromHex,
} from './lib/nfc-device';

interface LogEntry {
  id: number;
  timestamp: Date;
  type: 'info' | 'success' | 'error' | 'command' | 'response';
  message: string;
}

function App() {
  const [device, setDevice] = useState<NfcDevice | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [customCommand, setCustomCommand] = useState<string>('FF CA 00 00 00');
  const [blockNumber, setBlockNumber] = useState<number>(0);
  const [isPolling, setIsPolling] = useState<boolean>(false);
  const [lastUid, setLastUid] = useState<string>('');
  const pollingRef = useRef<boolean>(false);

  const addLog = useCallback((type: LogEntry['type'], message: string) => {
    setLogs(prev => [...prev, {
      id: Date.now() + Math.random(),
      timestamp: new Date(),
      type,
      message,
    }]);
  }, []);

  const clearLogs = useCallback(() => {
    setLogs([]);
  }, []);

  // Connect via Web Serial (preferred for Windows)
  const handleConnectSerial = async () => {
    if (!isWebSerialSupported()) {
      addLog('error', 'Web Serial API is not supported. Please use Chrome or Edge.');
      return;
    }

    addLog('info', 'Requesting serial port...');
    const result = await requestSerialPort();

    if (result.success && result.device) {
      const name = getSerialPortInfo(result.device.port);
      const nfcDevice: NfcDevice = {
        type: 'serial',
        name,
        serialDevice: result.device,
      };
      setDevice(nfcDevice);
      addLog('success', `Connected via Serial: ${name}`);
    } else {
      addLog('error', result.error || 'Failed to connect');
    }
  };

  // Connect via WebUSB (fallback)
  const handleConnectUsb = async () => {
    if (!isWebUsbSupported()) {
      addLog('error', 'WebUSB is not supported. Please use Chrome, Edge, or Opera.');
      return;
    }

    addLog('info', 'Requesting USB device...');
    const result = await requestUsbDevice();

    if (result.success && result.device) {
      const name = getDeviceInfo(result.device.device);
      const nfcDevice: NfcDevice = {
        type: 'usb',
        name,
        usbDevice: result.device,
      };
      setDevice(nfcDevice);
      addLog('success', `Connected via USB: ${name}`);
      addLog('info', `Interface: ${result.device.interfaceNumber}, EP In: ${result.device.endpointIn}, EP Out: ${result.device.endpointOut}`);
    } else {
      addLog('error', result.error || 'Failed to connect');
    }
  };

  const handleDisconnect = async () => {
    if (device) {
      pollingRef.current = false;
      setIsPolling(false);

      if (device.type === 'serial' && device.serialDevice) {
        await disconnectSerialPort(device.serialDevice);
      } else if (device.type === 'usb' && device.usbDevice) {
        await disconnectUsbDevice(device.usbDevice);
      }

      setDevice(null);
      setLastUid('');
      addLog('info', 'Disconnected from device');
    }
  };

  const executeCommand = async (
    name: string,
    commandFn: () => Promise<NfcCommandResult>
  ) => {
    if (!device) {
      addLog('error', 'No device connected');
      return;
    }

    addLog('command', `Executing: ${name}`);
    const result = await commandFn();

    if (result.success) {
      addLog('success', result.message);
      if (result.hexData) {
        addLog('response', `Data: ${result.hexData}`);
      }
    } else {
      addLog('error', result.message);
    }
  };

  const handleGetFirmware = () => executeCommand('Get Firmware', () => getFirmwareVersion(device!));
  const handleGetSerial = () => executeCommand('Get Serial Number', () => getSerialNumber(device!));
  const handlePollCard = () => executeCommand('Poll Card', () => pollCard(device!));

  const handleGetUid = async () => {
    if (!device) {
      addLog('error', 'No device connected');
      return;
    }

    addLog('command', 'Executing: Get Card UID');
    const result = await getCardUid(device);

    if (result.success) {
      addLog('success', result.message);
      if (result.hexData) {
        setLastUid(result.hexData);
        addLog('response', `UID: ${result.hexData}`);
      }
    } else {
      addLog('error', result.message);
    }
  };

  const handleGetAts = () => executeCommand('Get Card ATS', () => getCardAts(device!));
  const handleAntennaOn = () => executeCommand('Antenna ON', () => antennaOn(device!));
  const handleAntennaOff = () => executeCommand('Antenna OFF', () => antennaOff(device!));
  const handleBuzzer = () => executeCommand('Buzzer', () => buzzer(device!, 100));
  const handleLedRed = () => executeCommand('LED Red', () => ledControl(device!, true, false));
  const handleLedGreen = () => executeCommand('LED Green', () => ledControl(device!, false, true));
  const handleLedOff = () => executeCommand('LED Off', () => ledControl(device!, false, false));

  const handleLoadDefaultKey = async () => {
    if (!device) {
      addLog('error', 'No device connected');
      return;
    }

    addLog('command', 'Loading default key FF FF FF FF FF FF');
    const result = await loadKey(device, 0, fromHex('FF FF FF FF FF FF'));
    if (result.success) {
      addLog('success', result.message);
    } else {
      addLog('error', result.message);
    }
  };

  const handleAuthenticate = async () => {
    if (!device) {
      addLog('error', 'No device connected');
      return;
    }

    addLog('command', `Authenticating block ${blockNumber} with key A`);
    const result = await authenticate(device, blockNumber, 'A', 0);
    if (result.success) {
      addLog('success', result.message);
    } else {
      addLog('error', result.message);
    }
  };

  const handleReadBlock = async () => {
    if (!device) {
      addLog('error', 'No device connected');
      return;
    }

    addLog('command', `Reading block ${blockNumber}`);
    const result = await readBlock(device, blockNumber);
    if (result.success) {
      addLog('success', result.message);
      if (result.hexData) {
        addLog('response', `Block data: ${result.hexData}`);
      }
    } else {
      addLog('error', result.message);
    }
  };

  const handleCustomCommand = async () => {
    if (!device) {
      addLog('error', 'No device connected');
      return;
    }

    addLog('command', `Sending APDU: ${customCommand}`);

    try {
      const result = await sendCustomApdu(device, customCommand);

      if (result.success) {
        addLog('success', result.message);
        if (result.hexData) {
          addLog('response', `Response: ${result.hexData}`);
        }
      } else {
        addLog('error', result.message);
      }
    } catch (error) {
      addLog('error', `Command failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const togglePolling = async () => {
    if (!device) {
      addLog('error', 'No device connected');
      return;
    }

    if (isPolling) {
      pollingRef.current = false;
      setIsPolling(false);
      addLog('info', 'Stopped continuous polling');
    } else {
      pollingRef.current = true;
      setIsPolling(true);
      addLog('info', 'Started continuous polling (every 500ms)');

      let lastDetectedUid = '';

      const pollLoop = async () => {
        while (pollingRef.current && device) {
          try {
            const result = await getCardUid(device);
            if (result.success && result.hexData) {
              if (result.hexData !== lastDetectedUid) {
                lastDetectedUid = result.hexData;
                setLastUid(result.hexData);
                addLog('success', `Card detected! UID: ${result.hexData}`);
              }
            } else {
              lastDetectedUid = '';
            }
          } catch (error) {
            // Ignore polling errors
          }

          await new Promise(resolve => setTimeout(resolve, 500));
        }
      };

      pollLoop();
    }
  };

  const serialSupported = isWebSerialSupported();
  const usbSupported = isWebUsbSupported();

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 p-4">
      <div className="max-w-6xl mx-auto">
        <header className="mb-8">
          <h1 className="text-3xl font-bold text-blue-400 mb-2">NFC CDC Browser Reader</h1>
          <p className="text-gray-400">
            Web interface for NFC readers in CDC/Serial mode (RDR-518, ACR518, etc.)
          </p>
        </header>

        {!serialSupported && !usbSupported && (
          <div className="bg-red-900/50 border border-red-500 rounded-lg p-4 mb-6">
            <h2 className="text-red-400 font-semibold mb-2">Not Supported</h2>
            <p className="text-gray-300">
              Your browser does not support Web Serial or WebUSB. Please use Chrome or Edge.
            </p>
          </div>
        )}

        {/* Connection Section */}
        <section className="bg-gray-800 rounded-lg p-6 mb-6">
          <h2 className="text-xl font-semibold mb-4 text-blue-300">Device Connection</h2>
          <div className="flex flex-wrap items-center gap-4">
            {!device ? (
              <>
                <button
                  onClick={handleConnectSerial}
                  disabled={!serialSupported}
                  className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed px-6 py-2 rounded-lg font-medium transition-colors"
                >
                  Connect (Serial)
                </button>
                <button
                  onClick={handleConnectUsb}
                  disabled={!usbSupported}
                  className="bg-gray-600 hover:bg-gray-500 disabled:bg-gray-700 disabled:cursor-not-allowed px-6 py-2 rounded-lg font-medium transition-colors"
                >
                  Connect (USB)
                </button>
                <span className="text-gray-500 text-sm">
                  {serialSupported ? '← Recommended for Windows' : ''}
                </span>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <span className="w-3 h-3 bg-green-500 rounded-full animate-pulse"></span>
                  <span className="text-green-400 font-medium">{device.name}</span>
                  <span className="text-gray-500 text-sm">({device.type})</span>
                </div>
                <button
                  onClick={handleDisconnect}
                  className="bg-red-600 hover:bg-red-700 px-6 py-2 rounded-lg font-medium transition-colors"
                >
                  Disconnect
                </button>
              </>
            )}
          </div>
        </section>

        {/* UID Display */}
        {lastUid && (
          <section className="bg-green-900/30 border border-green-500/50 rounded-lg p-6 mb-6">
            <h2 className="text-xl font-semibold mb-2 text-green-300">Last Detected Card</h2>
            <div className="font-mono text-2xl text-green-400">{lastUid}</div>
          </section>
        )}

        {/* Commands Grid */}
        <section className="bg-gray-800 rounded-lg p-6 mb-6">
          <h2 className="text-xl font-semibold mb-4 text-blue-300">Reader Commands</h2>

          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3 mb-6">
            <CommandButton onClick={handleGetFirmware} disabled={!device}>
              Get Firmware
            </CommandButton>
            <CommandButton onClick={handleGetSerial} disabled={!device}>
              Get Serial
            </CommandButton>
            <CommandButton onClick={handlePollCard} disabled={!device}>
              Poll Card
            </CommandButton>
            <CommandButton onClick={handleGetUid} disabled={!device} highlight>
              Get UID
            </CommandButton>
            <CommandButton onClick={handleGetAts} disabled={!device}>
              Get ATS
            </CommandButton>
            <CommandButton onClick={togglePolling} disabled={!device} active={isPolling}>
              {isPolling ? 'Stop Polling' : 'Auto Poll'}
            </CommandButton>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3 mb-6">
            <CommandButton onClick={handleAntennaOn} disabled={!device}>
              Antenna ON
            </CommandButton>
            <CommandButton onClick={handleAntennaOff} disabled={!device}>
              Antenna OFF
            </CommandButton>
            <CommandButton onClick={handleBuzzer} disabled={!device}>
              Buzzer
            </CommandButton>
            <CommandButton onClick={handleLedRed} disabled={!device}>
              LED Red
            </CommandButton>
            <CommandButton onClick={handleLedGreen} disabled={!device}>
              LED Green
            </CommandButton>
            <CommandButton onClick={handleLedOff} disabled={!device}>
              LED Off
            </CommandButton>
          </div>

          {/* MIFARE Section */}
          <div className="border-t border-gray-700 pt-4 mt-4">
            <h3 className="text-lg font-medium mb-3 text-gray-300">MIFARE Classic Operations</h3>
            <div className="flex flex-wrap items-center gap-3 mb-3">
              <label className="text-gray-400">Block:</label>
              <input
                type="number"
                min="0"
                max="255"
                value={blockNumber}
                onChange={(e) => setBlockNumber(parseInt(e.target.value) || 0)}
                className="w-20 bg-gray-700 border border-gray-600 rounded px-3 py-1 text-white"
              />
              <CommandButton onClick={handleLoadDefaultKey} disabled={!device}>
                Load Default Key
              </CommandButton>
              <CommandButton onClick={handleAuthenticate} disabled={!device}>
                Authenticate
              </CommandButton>
              <CommandButton onClick={handleReadBlock} disabled={!device}>
                Read Block
              </CommandButton>
            </div>
          </div>

          {/* Custom Command */}
          <div className="border-t border-gray-700 pt-4 mt-4">
            <h3 className="text-lg font-medium mb-3 text-gray-300">Custom APDU Command</h3>
            <div className="flex flex-wrap items-center gap-3">
              <input
                type="text"
                value={customCommand}
                onChange={(e) => setCustomCommand(e.target.value.toUpperCase())}
                placeholder="FF CA 00 00 00"
                className="flex-1 min-w-64 bg-gray-700 border border-gray-600 rounded px-3 py-2 font-mono text-white"
              />
              <CommandButton onClick={handleCustomCommand} disabled={!device}>
                Send APDU
              </CommandButton>
            </div>
            <p className="text-gray-500 text-sm mt-2">
              Enter hex bytes separated by spaces (e.g., FF CA 00 00 00 for Get UID)
            </p>
          </div>
        </section>

        {/* Command Reference */}
        <section className="bg-gray-800 rounded-lg p-6 mb-6">
          <h2 className="text-xl font-semibold mb-4 text-blue-300">Common APDU Commands</h2>
          <div className="grid md:grid-cols-2 gap-4 font-mono text-sm">
            <CommandRef cmd="FF CA 00 00 00" desc="Get Card UID" />
            <CommandRef cmd="FF CA 01 00 00" desc="Get Card ATS/Historical Bytes" />
            <CommandRef cmd="FF 00 48 00 00" desc="Get Firmware Version" />
            <CommandRef cmd="FF 00 4A 00 00" desc="Get Serial Number" />
            <CommandRef cmd="FF 00 52 0A 00" desc="Buzzer (100ms)" />
            <CommandRef cmd="FF 00 40 0F 04 01 01 01 01" desc="LED Control" />
            <CommandRef cmd="FF 82 00 00 06 FF FF FF FF FF FF" desc="Load Key A (default)" />
            <CommandRef cmd="FF 86 00 00 05 01 00 00 60 00" desc="Auth Block 0, Key A" />
            <CommandRef cmd="FF B0 00 00 10" desc="Read Block 0 (16 bytes)" />
          </div>
        </section>

        {/* Log Output */}
        <section className="bg-gray-800 rounded-lg p-6">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-xl font-semibold text-blue-300">Log Output</h2>
            <button
              onClick={clearLogs}
              className="text-gray-400 hover:text-white text-sm px-3 py-1 border border-gray-600 rounded hover:border-gray-500 transition-colors"
            >
              Clear
            </button>
          </div>
          <div className="bg-gray-900 rounded-lg p-4 h-64 overflow-y-auto font-mono text-sm">
            {logs.length === 0 ? (
              <p className="text-gray-500">No logs yet. Connect a reader to get started.</p>
            ) : (
              logs.map((log) => (
                <LogLine key={log.id} log={log} />
              ))
            )}
          </div>
        </section>

        {/* Footer */}
        <footer className="mt-8 text-center text-gray-500 text-sm">
          <p>
            NFC CDC Browser Reader - Uses Web Serial / WebUSB to communicate with NFC readers
          </p>
          <p className="mt-1">
            Tested with RDR-518, ACS ACR1281S-C1 (ACR518), ACR122U, ACR1252U
          </p>
        </footer>
      </div>
    </div>
  );
}

interface CommandButtonProps {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  highlight?: boolean;
  active?: boolean;
}

function CommandButton({ onClick, disabled, children, highlight, active }: CommandButtonProps) {
  const baseClasses = 'px-4 py-2 rounded-lg font-medium transition-colors text-sm';
  const enabledClasses = highlight
    ? 'bg-green-600 hover:bg-green-700 text-white'
    : active
    ? 'bg-yellow-600 hover:bg-yellow-700 text-white'
    : 'bg-gray-700 hover:bg-gray-600 text-gray-200';
  const disabledClasses = 'bg-gray-800 text-gray-500 cursor-not-allowed';

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`${baseClasses} ${disabled ? disabledClasses : enabledClasses}`}
    >
      {children}
    </button>
  );
}

interface CommandRefProps {
  cmd: string;
  desc: string;
}

function CommandRef({ cmd, desc }: CommandRefProps) {
  return (
    <div className="bg-gray-700/50 rounded p-2">
      <code className="text-blue-300">{cmd}</code>
      <span className="text-gray-400 ml-2">- {desc}</span>
    </div>
  );
}

interface LogLineProps {
  log: LogEntry;
}

function LogLine({ log }: LogLineProps) {
  const colors = {
    info: 'text-gray-400',
    success: 'text-green-400',
    error: 'text-red-400',
    command: 'text-yellow-400',
    response: 'text-blue-400',
  };

  const prefix = {
    info: '[INFO]',
    success: '[OK]',
    error: '[ERR]',
    command: '[CMD]',
    response: '[RSP]',
  };

  const time = log.timestamp.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  return (
    <div className={`${colors[log.type]} mb-1`}>
      <span className="text-gray-600">{time}</span>
      <span className="mx-2">{prefix[log.type]}</span>
      <span>{log.message}</span>
    </div>
  );
}

export default App;
