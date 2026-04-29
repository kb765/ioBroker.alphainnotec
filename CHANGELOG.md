# Changelog

All notable changes to this project will be documented in this file.

## [1.0.8] - 2026-04-29

### Added
- Dynamic state hierarchy based on WebSocket section structure
- Automatic channel creation for: `temperaturen`, `eingaenge`, `ausgaenge`, `betriebsstunden`, `waermemenge`, `anlagenstatus`, etc.
- Smart state role and unit assignment based on section/name patterns
- Comprehensive debug logging for troubleshooting

### Changed
- **BREAKING**: Removed hardcoded state mapping (old `temperatures.outdoor`, `temperatures.flow`, `temperatures.return` states)
- Replaced with automatic discovery: all 224+ sensor values now available via WebSocket
- Improved `sanitizeKey()` to strip trailing dots/underscores from state IDs
- Reduced verbose logging (removed spam about "Poll started", "Poll: Got X keys", etc.)
- Removed debug log spam in `syncDynamicLuxStates()`

### Fixed
- State ID validation errors for keys ending with `.` (e.g., `netzeinschaltv.`, `betriebstunden_heiz.`)
- Proper type conversion for numeric, boolean, and string values in `setStateAsync()`
- Removed legacy `allValues` channel that was cluttering the tree

### Technical
- All WebSocket message handling remains synchronous (critical for controller reliability)
- REFRESH loop continues at 500ms intervals for live updates
- 15-second timeout per poll cycle

## [1.0.7] - 2026-04-29

### Fixed
- WS Content section parsing: now correctly extracts actual section names from `<name>` child elements
- Previously: all Content tags labeled as "content", now: "temperaturen", "eingaenge", etc.

## [1.0.6] - 2026-04-29

### Fixed
- WebSocket protocol: removed invalid `GET;Navigation` command
- Changed to synchronous section requests after Navigation push
- Removed all `setTimeout` delays (was causing connection closure)
- Result: now receives 20+ measurement messages instead of 1

## [1.0.5] - 2026-04-28

### Added
- Triple-guard against HTTP library sources (.js, .css, minified JS banners)
- Better WebSocket parsing and refresh request handling

## [1.0.4] - 2026-04-27

### Fixed
- Filter script/css from fallback sources
- Improve WebSocket refresh requests

## [1.0.3] - 2026-04-26

### Improved
- WebSocket navigation traversal
- Measurement key detection

## [1.0.2] - 2026-04-25

### Added
- Recursive WebSocket item traversal for nested Luxtronik pages

## [1.0.1] - 2026-04-24

### Improved
- WebSocket parsing diagnostics
- Fallback handling

## [1.0.0] - 2026-04-23

### Added
- Initial release
- Basic HTTP scraping of Luxtronik web frontend
- Simple state creation for core temperatures
- Configuration via IP, PIN, poll interval
