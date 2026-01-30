import { useState, useCallback, useRef } from 'react';
import {
  isWebSerialSupported,
  requestSerialPort,
  disconnectSerialPort,
  getSerialPortInfo,
} from './lib/web-serial';
import {
  NfcDevice,
  NfcVersionInfo,
  cardHunt,
  sendCustomCommand,
  setLeds,
  beepSuccess,
  getFirmwareVersion,
  endTagCommunication,
  LED,
  toHex,
  buildHuntCommand,
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
  const [customCommand, setCustomCommand] = useState<string>('');
  const [isHunting, setIsHunting] = useState<boolean>(false);
  const [lastUid, setLastUid] = useState<string>('');
  const [lastAtqa, setLastAtqa] = useState<string>('');
  const [lastSak, setLastSak] = useState<string>('');
  const [firmwareInfo, setFirmwareInfo] = useState<NfcVersionInfo | null>(null);
  const huntingRef = useRef<boolean>(false);

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

  // Connect via Web Serial
  const handleConnect = async () => {
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
      addLog('success', `Connected: ${name}`);
    } else {
      addLog('error', result.error || 'Failed to connect');
    }
  };

  const handleDisconnect = async () => {
    if (device) {
      huntingRef.current = false;
      setIsHunting(false);

      if (device.serialDevice) {
        await disconnectSerialPort(device.serialDevice);
      }

      setDevice(null);
      setLastUid('');
      setLastAtqa('');
      setLastSak('');
      setFirmwareInfo(null);
      addLog('info', 'Disconnected from device');
    }
  };

  const handleCardHunt = async () => {
    if (!device) {
      addLog('error', 'No device connected');
      return;
    }

    // Show the command being sent
    const command = buildHuntCommand();
    addLog('command', `Card Hunt: ${toHex(command)}`);

    const result = await cardHunt(device);

    if (result.success) {
      addLog('success', result.message);
      if (result.hexData) {
        setLastUid(result.hexData);
        setLastAtqa(result.atqa || '');
        setLastSak(result.sak || '');
        addLog('response', `UID: ${result.hexData}`);
        if (result.atqa) addLog('response', `ATQA: ${result.atqa}`);
        if (result.sak) addLog('response', `SAK: ${result.sak}`);
        if (result.comType !== undefined) {
          addLog('response', `COM Type: 0x${result.comType.toString(16).padStart(2, '0')}`);
        }
        await beepSuccess(device);
      }
    } else {
      addLog('info', result.message);
      if (result.hexData) {
        addLog('response', `Raw: ${result.hexData}`);
      }
    }
  };

  const handleCustomCommand = async () => {
    if (!device) {
      addLog('error', 'No device connected');
      return;
    }

    addLog('command', `Sending: ${customCommand}`);

    try {
      const result = await sendCustomCommand(device, customCommand);

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

  const toggleHunting = async () => {
    if (!device) {
      addLog('error', 'No device connected');
      return;
    }

    if (isHunting) {
      huntingRef.current = false;
      setIsHunting(false);
      addLog('info', 'Stopped continuous card hunt');
    } else {
      huntingRef.current = true;
      setIsHunting(true);
      addLog('info', 'Started continuous card hunt');

      let lastDetectedUid = '';

      const huntLoop = async () => {
        while (huntingRef.current && device) {
          try {
            const result = await cardHunt(device);
            if (result.success && result.hexData) {
              if (result.hexData !== lastDetectedUid) {
                lastDetectedUid = result.hexData;
                setLastUid(result.hexData);
                setLastAtqa(result.atqa || '');
                setLastSak(result.sak || '');
                addLog('success', `Card detected! UID: ${result.hexData}`);
                await beepSuccess(device);
              }
            } else {
              lastDetectedUid = '';
            }
          } catch {
            // Ignore hunt errors
          }

          await new Promise(resolve => setTimeout(resolve, 100));
        }
      };

      huntLoop();
    }
  };

  const handleLedControl = async (param: number, description: string) => {
    if (!device) {
      addLog('error', 'No device connected');
      return;
    }

    addLog('command', `LED Control: ${description}`);
    const success = await setLeds(device, param);
    if (success) {
      addLog('success', 'LED command sent');
    } else {
      addLog('error', 'LED command failed');
    }
  };

  const handleGetFirmware = async () => {
    if (!device) {
      addLog('error', 'No device connected');
      return;
    }

    addLog('command', 'Getting firmware version...');
    const result = await getFirmwareVersion(device);

    if (result.success && result.version) {
      setFirmwareInfo(result.version);
      addLog('success', result.message);
      addLog('response', `Raw: ${result.version.raw}`);
      if (result.hexData) {
        addLog('response', `Hex: ${result.hexData}`);
      }
    } else {
      addLog('error', result.message);
      if (result.hexData) {
        addLog('response', `Raw: ${result.hexData}`);
      }
    }
  };

  const handleEndTag = async (disconnect: boolean) => {
    if (!device) {
      addLog('error', 'No device connected');
      return;
    }

    addLog('command', `End tag communication (disconnect=${disconnect})...`);
    const result = await endTagCommunication(device, disconnect);

    if (result.success) {
      addLog('success', result.message);
      if (disconnect) {
        setLastUid('');
        setLastAtqa('');
        setLastSak('');
      }
    } else {
      addLog('error', result.message);
    }
    if (result.hexData) {
      addLog('response', `Raw: ${result.hexData}`);
    }
  };

  const serialSupported = isWebSerialSupported();

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 p-4">
      <div className="max-w-4xl mx-auto">
        <header className="mb-8">
          <h1 className="text-3xl font-bold text-blue-400 mb-2">NFC Card Hunt Reader</h1>
          <p className="text-gray-400">
            ASK CSC Protocol interface for RDR-518 NFC reader
          </p>
        </header>

        {!serialSupported && (
          <div className="bg-red-900/50 border border-red-500 rounded-lg p-4 mb-6">
            <h2 className="text-red-400 font-semibold mb-2">Not Supported</h2>
            <p className="text-gray-300">
              Your browser does not support Web Serial. Please use Chrome or Edge.
            </p>
          </div>
        )}

        {/* Connection Section */}
        <section className="bg-gray-800 rounded-lg p-6 mb-6">
          <h2 className="text-xl font-semibold mb-4 text-blue-300">Device Connection</h2>
          <div className="flex flex-wrap items-center gap-4">
            {!device ? (
              <button
                onClick={handleConnect}
                disabled={!serialSupported}
                className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed px-6 py-2 rounded-lg font-medium transition-colors"
              >
                Connect
              </button>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <span className="w-3 h-3 bg-green-500 rounded-full animate-pulse"></span>
                  <span className="text-green-400 font-medium">{device.name}</span>
                </div>
                <button
                  onClick={handleGetFirmware}
                  className="bg-gray-700 hover:bg-gray-600 px-4 py-2 rounded-lg font-medium transition-colors"
                >
                  Get Firmware
                </button>
                <button
                  onClick={handleDisconnect}
                  className="bg-red-600 hover:bg-red-700 px-6 py-2 rounded-lg font-medium transition-colors"
                >
                  Disconnect
                </button>
              </>
            )}
          </div>
          {firmwareInfo && (
            <div className="mt-4 p-3 bg-gray-700/50 rounded-lg text-sm">
              <div className="text-gray-300">
                <span className="text-blue-400 font-medium">Firmware:</span>{' '}
                {firmwareInfo.model} {firmwareInfo.type} v{firmwareInfo.version}
              </div>
              {firmwareInfo.buildDate && (
                <div className="text-gray-400">
                  Build: {firmwareInfo.buildDate} {firmwareInfo.buildTime}
                </div>
              )}
            </div>
          )}
        </section>

        {/* UID Display */}
        {lastUid && (
          <section className="bg-green-900/30 border border-green-500/50 rounded-lg p-6 mb-6">
            <h2 className="text-xl font-semibold mb-2 text-green-300">Last Detected Card</h2>
            <div className="font-mono text-2xl text-green-400 mb-2">{lastUid}</div>
            {(lastAtqa || lastSak) && (
              <div className="text-sm text-gray-400">
                {lastAtqa && <span className="mr-4">ATQA: {lastAtqa}</span>}
                {lastSak && <span>SAK: {lastSak}</span>}
              </div>
            )}
          </section>
        )}

        {/* Card Hunt Section */}
        <section className="bg-gray-800 rounded-lg p-6 mb-6">
          <h2 className="text-xl font-semibold mb-4 text-blue-300">Card Hunt</h2>

          <div className="flex flex-wrap gap-3 mb-4">
            <button
              onClick={handleCardHunt}
              disabled={!device || isHunting}
              className={`px-6 py-3 rounded-lg font-medium transition-colors text-lg ${
                device && !isHunting
                  ? 'bg-purple-600 hover:bg-purple-700 text-white'
                  : 'bg-gray-800 text-gray-500 cursor-not-allowed'
              }`}
            >
              Hunt Once
            </button>
            <button
              onClick={toggleHunting}
              disabled={!device}
              className={`px-6 py-3 rounded-lg font-medium transition-colors ${
                !device
                  ? 'bg-gray-800 text-gray-500 cursor-not-allowed'
                  : isHunting
                  ? 'bg-orange-600 hover:bg-orange-700 text-white'
                  : 'bg-gray-700 hover:bg-gray-600 text-gray-200'
              }`}
            >
              {isHunting ? 'Stop Hunt' : 'Continuous Hunt'}
            </button>
            <button
              onClick={() => handleEndTag(true)}
              disabled={!device}
              className={`px-6 py-3 rounded-lg font-medium transition-colors ${
                device
                  ? 'bg-red-700 hover:bg-red-600 text-white'
                  : 'bg-gray-800 text-gray-500 cursor-not-allowed'
              }`}
            >
              End Tag
            </button>
          </div>
        </section>

        {/* LED/Buzzer Control */}
        <section className="bg-gray-800 rounded-lg p-6 mb-6">
          <h2 className="text-xl font-semibold mb-4 text-blue-300">LED / Buzzer Control</h2>
          <div className="flex flex-wrap gap-3">
            <button
              onClick={() => handleLedControl(LED.CPU_LED1, 'CPU LED1 (Green)')}
              disabled={!device}
              className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                device
                  ? 'bg-green-600 hover:bg-green-700 text-white'
                  : 'bg-gray-800 text-gray-500 cursor-not-allowed'
              }`}
            >
              LED1 (Green)
            </button>
            <button
              onClick={() => handleLedControl(LED.CPU_LED2, 'CPU LED2 (Yellow)')}
              disabled={!device}
              className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                device
                  ? 'bg-yellow-600 hover:bg-yellow-700 text-white'
                  : 'bg-gray-800 text-gray-500 cursor-not-allowed'
              }`}
            >
              LED2 (Yellow)
            </button>
            <button
              onClick={() => handleLedControl(LED.CPU_LED3, 'CPU LED3 (Red)')}
              disabled={!device}
              className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                device
                  ? 'bg-red-600 hover:bg-red-700 text-white'
                  : 'bg-gray-800 text-gray-500 cursor-not-allowed'
              }`}
            >
              LED3 (Red)
            </button>
            <button
              onClick={() => handleLedControl(LED.ANT_BUZZER, 'Buzzer')}
              disabled={!device}
              className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                device
                  ? 'bg-blue-600 hover:bg-blue-700 text-white'
                  : 'bg-gray-800 text-gray-500 cursor-not-allowed'
              }`}
            >
              Buzzer
            </button>
            <button
              onClick={() => handleLedControl(0x0000, 'All OFF')}
              disabled={!device}
              className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                device
                  ? 'bg-gray-700 hover:bg-gray-600 text-gray-200'
                  : 'bg-gray-800 text-gray-500 cursor-not-allowed'
              }`}
            >
              All OFF
            </button>
          </div>
        </section>

        {/* Custom Command */}
        <section className="bg-gray-800 rounded-lg p-6 mb-6">
          <h2 className="text-xl font-semibold mb-4 text-blue-300">Custom Command</h2>
          <div className="flex flex-wrap items-center gap-3">
            <input
              type="text"
              value={customCommand}
              onChange={(e) => setCustomCommand(e.target.value.toUpperCase())}
              placeholder="80 0B 01 03 00 00 02 11 03 01 01 14 00"
              className="flex-1 min-w-64 bg-gray-700 border border-gray-600 rounded px-3 py-2 font-mono text-white text-sm"
            />
            <button
              onClick={handleCustomCommand}
              disabled={!device || !customCommand.trim()}
              className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                device && customCommand.trim()
                  ? 'bg-gray-700 hover:bg-gray-600 text-gray-200'
                  : 'bg-gray-800 text-gray-500 cursor-not-allowed'
              }`}
            >
              Send
            </button>
          </div>
          <p className="text-gray-500 text-sm mt-2">
            Enter hex bytes separated by spaces (CRC will be calculated automatically)
          </p>
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
            NFC Card Hunt Reader - ASK CSC Protocol via Web Serial
          </p>
          <p className="mt-1">
            Tested with RDR-518
          </p>
        </footer>
      </div>
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
