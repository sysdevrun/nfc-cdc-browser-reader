# NFC CDC Browser Reader

A web-based NFC reader interface that uses WebUSB to communicate with ACS ACR518 (ACR1281S-C1) and compatible NFC readers configured in CDC (serial) mode.

## Features

- **WebUSB CDC Communication**: Direct USB communication with NFC readers in CDC/serial mode
- **Card UID Reading**: Read NFC card unique identifiers (MIFARE, ISO14443-A)
- **Reader Commands**: Send common reader commands (firmware version, serial number, antenna control)
- **MIFARE Classic Support**: Authenticate and read MIFARE Classic card blocks
- **Custom APDU**: Send custom APDU commands for advanced operations
- **Continuous Polling**: Auto-detect cards when placed on the reader
- **LED/Buzzer Control**: Control reader LEDs and buzzer for feedback

## Supported Readers

- ACS ACR1281S-C1 (ACR518)
- ACS ACR122U
- ACS ACR1252U
- Other ACS readers in CDC mode
- Generic USB-CDC NFC readers

## Browser Requirements

WebUSB is required. Supported browsers:
- Google Chrome (recommended)
- Microsoft Edge
- Opera

**Note**: Firefox and Safari do not support WebUSB.

## How to Read a Card UID

1. Open the application in a supported browser
2. Click "Connect Reader" and select your NFC reader from the popup
3. Place an NFC card on the reader
4. Click "Get UID" to read the card's unique identifier

For continuous reading, click "Auto Poll" to automatically detect cards.

## Common APDU Commands

| Command | Description |
|---------|-------------|
| `FF CA 00 00 00` | Get Card UID |
| `FF CA 01 00 00` | Get Card ATS/Historical Bytes |
| `FF 00 48 00 00` | Get Firmware Version |
| `FF 00 4A 00 00` | Get Serial Number |
| `FF 00 52 0A 00` | Buzzer (100ms) |
| `FF 82 00 00 06 FF FF FF FF FF FF` | Load Default Key |
| `FF 86 00 00 05 01 00 BB 60 00` | Authenticate Block BB with Key A |
| `FF B0 00 BB 10` | Read Block BB (16 bytes) |

## ACR518 CDC Mode Setup

To configure an ACS ACR1281S-C1 (ACR518) for CDC mode:

1. Use the ACS reader configuration tool
2. Set the operation mode to "CDC" or "Serial"
3. The reader will appear as a USB CDC device (COM port on Windows, ttyACM on Linux)

## Development

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

## Deployment

This project is configured to deploy to GitHub Pages automatically when pushing to the main branch.

The GitHub Actions workflow will:
1. Install dependencies
2. Build the project with `./` as the base path
3. Deploy to GitHub Pages

## Technical Details

### Protocol

The application uses the USB CDC (Communications Device Class) protocol to communicate with NFC readers. For ACS readers in CDC mode:

- Commands are wrapped in a frame: `STX (0x02) + LEN (2 bytes) + DATA + ETX (0x03) + LRC`
- APDU commands use the PC/SC-lite pseudo-APDU format with CLA=0xFF
- Responses follow the same framing with SW1/SW2 status bytes

### Security Note

WebUSB requires user interaction to connect to devices, ensuring that web pages cannot access USB devices without explicit permission.

## License

MIT
