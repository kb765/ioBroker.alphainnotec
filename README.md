# ioBroker.alphainnotec

ioBroker adapter for **alpha innotec Luxtronik SWC** heat pump controllers.

Reads all sensor data (temperatures, inputs, outputs, runtime, energy totals) via **WebSocket** protocol and exposes them as ioBroker states with automatic hierarchical organization.

## Features

✅ **WebSocket-based data retrieval** – Real-time sensor data via `ws://IP:8214` (Lux_WS subprotocol)  
✅ **Dynamic state hierarchy** – Automatic channel/state creation based on controller response  
✅ **Comprehensive sensor coverage** – Temperatures (Vorlauf, Rücklauf, Außentemp, etc.), Inputs (ASD, EVU, HD, MOT, ND), Outputs (Verdichter, Heizung, WW, etc.), Runtime, Energy  
✅ **Smart XML parsing** – Extracts section names and item values from `<Content>` tags  
✅ **HTTP fallback** – Graceful degradation if WebSocket unavailable  
✅ **Configurable polling** – Adjustable poll interval (min 15s)  

## Installation

1. Install adapter in ioBroker admin interface, OR:
   ```bash
   npm install iobroker.alphainnotec
   ```

2. Configure adapter instance:
   - **IP Address**: IP of your Luxtronik controller (e.g., `192.168.1.12`)
   - **PIN**: Access PIN for authentication
   - **Poll Interval**: Seconds between polls (default: 60, min: 15)
   - **WebSocket Port**: Port 8214 (usually not needed to change)

3. Restart adapter

## Configuration

In **Adapter settings** configure:

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `ip` | String | - | IP address of Luxtronik web interface |
| `pin` | String | - | PIN for WebSocket/HTTP authentication |
| `pollInterval` | Number | 60 | Polling interval in seconds (min: 15) |
| `wsPort` | Number | 8214 | WebSocket port (Lux_WS subprotocol) |
| `dataUrl` | String | - | Custom data endpoint (optional) |

## State Structure

States are automatically created with this hierarchy:

```
alphainnotec.0
├── temperatures/           (Channel)
│   ├── vorlauf            (number, °C)
│   ├── ruecklauf          (number, °C)
│   ├── heissgas           (number, °C)
│   ├── aussentemperatur   (number, °C)
│   └── ...
├── eingaenge/             (Channel)
│   ├── asd                (boolean)
│   ├── evu                (boolean)
│   ├── hd                 (boolean)
│   └── ...
├── ausgaenge/             (Channel)
│   ├── verdichter         (boolean)
│   ├── bup                (boolean)
│   ├── fup_1              (boolean)
│   └── ...
├── betriebsstunden/       (Channel)
│   ├── betriebsstunden_wp (number, h)
│   ├── betriebsstunden_heiz. (number, h)
│   └── ...
├── waermemenge/           (Channel)
│   ├── gesamt             (number, kWh)
│   ├── heizung            (number, kWh)
│   └── warmwasser         (number, kWh)
├── anlagenstatus/         (Channel)
│   ├── betriebszustand    (string)
│   ├── softwarestand      (string)
│   └── ...
└── info/                  (Channel)
    ├── endpoint           (string) - Last successful data source
    ├── parsedKeys         (string) - All discovered state keys
    └── rawPreview         (string) - Raw data sample
```

**All states are automatically populated** – new sensors/sections appear automatically when the controller responds.

## Tested Hardware

- **Luxtronik SWC** Firmware V1.86.2
- **Heat Pump**: Alpha Innotec LWBH 140-25
- **Connection**: Raspberry Pi 4, ioBroker 7.0.7+

## How It Works

1. **Initialization** → Creates ioBroker channels for `info`, `temperatures`, etc.
2. **WebSocket Connection** → Opens `ws://IP:8214` with `Lux_WS` subprotocol
3. **Authentication** → Sends `LOGIN;{PIN}`
4. **Navigation Request** → Controller auto-pushes Navigation XML with section IDs
5. **Section Requests** → Adapter sends synchronous `GET;{sectionId}` for each section
6. **XML Parsing** → Extracts `<Content>` tags, item names, and values
7. **State Sync** → Creates/updates ioBroker states with proper roles and units
8. **Repeat** → Polls at configured interval (default 60s)

## Troubleshooting

**No states created?**
- Check IP address is correct and reachable
- Verify PIN is correct in adapter config
- Check ioBroker logs: `iobroker logs alphainnotec.0`

**WebSocket connection fails?**
- Ensure Port 8214 is open and not blocked by firewall
- Verify Luxtronik device is powered on
- Check if HTTP fallback works (slower but works without WebSocket)

**States have no values?**
- Wait 1-2 minutes for first poll
- Check `alphainnotec.0.info.endpoint` to see last data source
- Verify device is responding (ping IP address)

## Development

```bash
# Build TypeScript
npm run build

# Pack for deployment
npm pack

# Deploy to ioBroker
npm install ./iobroker.alphainnotec-*.tgz --force
iobroker upload alphainnotec
iobroker restart alphainnotec.0
```

## License

CC BY-NC-SA 4.0

## Support

For issues, feature requests, or questions:
- Check existing issues on GitHub
- Review ioBroker adapter documentation: https://github.com/ioBroker/ioBroker.adapter-creator
