import axios, { AxiosInstance } from "axios";
import * as utils from "@iobroker/adapter-core";
import WebSocket from "ws";

type MeasurementMap = {
  outdoorTemp?: number;
  flowTemp?: number;
  returnTemp?: number;
};

type PollResult = {
  measurements: MeasurementMap;
  discoveredValues: Record<string, number>;
  discoveredAny: Record<string, string | number | boolean>;
  endpoint: string;
  rawPreview: string;
};

type AlphainnotecConfig = ioBroker.AdapterConfig & {
  ip?: string;
  pin?: string;
  pollInterval?: number;
  dataUrl?: string;
  wsPort?: number;
};

class AlphainnotecAdapter extends utils.Adapter {
  private client: AxiosInstance;

  public constructor(options: Partial<utils.AdapterOptions> = {}) {
    super({
      ...options,
      name: "alphainnotec",
    });

    this.client = axios.create({ timeout: 10000 });

    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }

  private async onReady(): Promise<void> {
    const config = this.config as AlphainnotecConfig;
    const ip = String(config.ip || "").trim();
    const pin = String(config.pin || "").trim();
    const dataUrl = String(config.dataUrl || "").trim();
    const wsPort = Number(config.wsPort || 8214);
    const intervalSeconds = Number(config.pollInterval || 60);

    if (!ip) {
      this.log.error("No IP configured. Please set ip in instance settings.");
      return;
    }

    if (!pin) {
      this.log.warn("No PIN configured. Requests may fail if the device requires authentication.");
    }

    await this.createStates();

    await this.poll(ip, pin, dataUrl, wsPort);

    const intervalMs = Math.max(15, intervalSeconds) * 1000;
    this.setInterval(async () => {
      await this.poll(ip, pin, dataUrl, wsPort);
    }, intervalMs);
  }

  private async createStates(): Promise<void> {
    await this.extendObjectAsync("info", {
      type: "channel",
      common: { name: "Info" },
      native: {},
    });

    await this.extendObjectAsync("info.endpoint", {
      type: "state",
      common: {
        name: "Last successful endpoint",
        type: "string",
        role: "text",
        read: true,
        write: false,
      },
      native: {},
    });

    await this.extendObjectAsync("info.rawPreview", {
      type: "state",
      common: {
        name: "Raw data preview",
        type: "string",
        role: "text",
        read: true,
        write: false,
      },
      native: {},
    });

    await this.extendObjectAsync("info.parsedKeys", {
      type: "state",
      common: {
        name: "Parsed keys",
        type: "string",
        role: "text",
        read: true,
        write: false,
      },
      native: {},
    });

    await this.extendObjectAsync("allValues", {
      type: "channel",
      common: { name: "All discovered numeric values" },
      native: {},
    });
  }

  private async poll(ip: string, pin: string, dataUrl: string, wsPort: number): Promise<void> {
    try {
      const result = await this.readMeasurements(ip, pin, dataUrl, wsPort);
      const values = result.measurements;

      if (values.outdoorTemp !== undefined) {
        await this.setStateAsync("temperatures.outdoor", values.outdoorTemp, true);
      }
      if (values.flowTemp !== undefined) {
        await this.setStateAsync("temperatures.flow", values.flowTemp, true);
      }
      if (values.returnTemp !== undefined) {
        await this.setStateAsync("temperatures.return", values.returnTemp, true);
      }

      await this.setStateAsync("info.endpoint", result.endpoint, true);
      await this.setStateAsync("info.rawPreview", result.rawPreview, true);
      await this.setStateAsync("info.parsedKeys", Object.keys(result.discoveredAny).sort().join(", "), true);
      await this.syncDynamicLuxStates(result.discoveredAny);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error(`Polling failed: ${message}`);
    }
  }

  private async readMeasurements(ip: string, pin: string, dataUrl: string, wsPort: number): Promise<PollResult> {
    const websocketResult = await this.readViaWebSocket(ip, pin, wsPort);
    if (websocketResult) {
      return websocketResult;
    }

    const baseUrl = `http://${ip}`;

    const candidateUrls = [
      ...(dataUrl ? [this.toAbsoluteUrl(baseUrl, dataUrl)] : []),
      `${baseUrl}/cgi/readTags?pin=${encodeURIComponent(pin)}`,
      `${baseUrl}/cgi/readTags?password=${encodeURIComponent(pin)}`,
      `${baseUrl}/cgi/readValues?pin=${encodeURIComponent(pin)}`,
      `${baseUrl}/cgi/readTags`,
      `${baseUrl}/cgi/readValues`,
      `${baseUrl}/temperaturen.html`,
      `${baseUrl}/status.html`,
      `${baseUrl}/diagnose.html`,
      `${baseUrl}/`,
    ];

    let lastError: unknown;

    for (const url of [...new Set(candidateUrls)]) {
      try {
        const response = await this.client.get(url, {
          responseType: "text",
          validateStatus: (status) => status >= 200 && status < 300,
        });

        const rawText = typeof response.data === "string" ? response.data : JSON.stringify(response.data);
        if (this.looksLikeLibrarySource(url, rawText)) {
          continue;
        }

        const extraction = this.extractMeasurements(rawText);

        if (this.isMeaningfulDiscovery(extraction.discoveredAny)) {
          return {
            measurements: extraction.measurements,
            discoveredValues: extraction.discoveredValues,
            discoveredAny: extraction.discoveredAny,
            endpoint: url,
            rawPreview: this.limitText(rawText, 500),
          };
        }

        if (this.isLikelyHtml(rawText)) {
          const linkedUrls = this.extractHtmlLinks(rawText, baseUrl);
          for (const linkedUrl of linkedUrls) {
            try {
              const linkedResponse = await this.client.get(linkedUrl, {
                responseType: "text",
                validateStatus: (status) => status >= 200 && status < 300,
              });

              const linkedRawText = typeof linkedResponse.data === "string"
                ? linkedResponse.data
                : JSON.stringify(linkedResponse.data);
              if (this.looksLikeLibrarySource(linkedUrl, linkedRawText)) {
                continue;
              }
              const linkedExtraction = this.extractMeasurements(linkedRawText);
              if (!this.isMeaningfulDiscovery(linkedExtraction.discoveredAny)) {
                continue;
              }

              return {
                measurements: linkedExtraction.measurements,
                discoveredValues: linkedExtraction.discoveredValues,
                discoveredAny: linkedExtraction.discoveredAny,
                endpoint: linkedUrl,
                rawPreview: this.limitText(linkedRawText, 500),
              };
            } catch {
              // Best effort: ignore unreachable linked pages.
            }
          }
        }
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error("No Luxtronik endpoint responded with measurement data.");
  }

  private async readViaWebSocket(ip: string, pin: string, wsPort: number): Promise<PollResult | undefined> {
    const endpoint = `ws://${ip}:${wsPort}`;

    try {
      return await new Promise<PollResult>((resolve, reject) => {
        const ws = new WebSocket(endpoint, "Lux_WS");
        const xmlMessages: string[] = [];
        const requestedIds = new Set<string>();
        let refreshTimer: NodeJS.Timeout | undefined;
        let finishTimer: NodeJS.Timeout | undefined;
        let settled = false;

        const finish = (error?: Error): void => {
          if (settled) {
            return;
          }
          settled = true;
          if (refreshTimer) {
            clearInterval(refreshTimer);
          }
          if (finishTimer) {
            clearTimeout(finishTimer);
          }
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close();
          }

          if (error) {
            reject(error);
            return;
          }
          const parsed = this.parseLuxWebSocketMessages(xmlMessages);
          if (!this.hasMeasurementLikeKeys(parsed.discoveredAny)) {
            const roots = Array.from(new Set(
              xmlMessages
                .map((msg) => msg.match(/<([A-Za-z0-9_:-]+)(?:\s|>)/)?.[1]?.toLowerCase())
                .filter((tag): tag is string => Boolean(tag))
            )).slice(0, 8);
            reject(new Error(
              `Luxtronik websocket connected but no measurement-like values were found. wsMessages=${xmlMessages.length}; roots=${roots.join("|") || "none"}; keys=${Object.keys(parsed.discoveredAny).slice(0, 12).join("|") || "none"}; sample=${this.limitText(parsed.rawPreview, 180)}`
            ));
            return;
          }

          const measurements = this.inferMeasurements(parsed.discoveredAny);
          resolve({
            measurements,
            discoveredValues: parsed.discoveredValues,
            discoveredAny: parsed.discoveredAny,
            endpoint,
            rawPreview: this.limitText(parsed.rawPreview, 500),
          });
        };

        ws.on("open", () => {
          const auth = pin.length ? pin : "0";
          ws.send(`LOGIN;${auth}`);
          // The controller automatically pushes Navigation after LOGIN.
          // Do NOT send GET;Navigation - it is not a valid section ID and causes the controller to close.
          // Wait for Navigation in the message handler, then send GET;{sectionId} synchronously.
          finishTimer = setTimeout(() => finish(), 15000);
        });

        ws.on("message", (data: WebSocket.RawData) => {
          const xml = typeof data === "string" ? data : data.toString("utf8");
          this.log.debug(`WS msg #${xmlMessages.length + 1} (${xml.length}B): ${xml.slice(0, 300)}`);
          xmlMessages.push(xml);

          // When Navigation arrives, immediately (synchronously) request all measurement sections.
          // Using setTimeout here would be too late - the controller closes the connection quickly.
          if (/<Navigation[\s>]/i.test(xml) && ws.readyState === WebSocket.OPEN) {
            const navigationTargets = this.extractNavigationTargets(xml);
            const preferred = navigationTargets.filter((entry) =>
              /temperaturen|eing[aä]nge|ausg[aä]nge|ablaufzeiten|betriebsstunden|fehlerspeicher|abschaltungen|anlagenstatus|w[aä]rmemenge|glt/i.test(entry.name)
            );
            for (const entry of preferred.slice(0, 10)) {
              if (!requestedIds.has(entry.id)) {
                requestedIds.add(entry.id);
                ws.send(`GET;${entry.id}`);
              }
            }
            // Start REFRESH loop only after we've selected a section.
            if (!refreshTimer) {
              refreshTimer = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send("REFRESH");
                }
              }, 500);
            }
            return;
          }
        });

        ws.on("error", (err: unknown) => finish(err instanceof Error ? err : new Error(String(err))));
        ws.on("close", () => finish());
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.debug(`WebSocket parsing failed, fallback to HTTP scraping: ${message}`);
      return undefined;
    }
  }

  private parseLuxWebSocketMessages(messages: string[]): {
    discoveredValues: Record<string, number>;
    discoveredAny: Record<string, string | number | boolean>;
    rawPreview: string;
  } {
    const discoveredAny: Record<string, string | number | boolean> = {};

    for (const xml of messages) {
      const sectionMatch = xml.match(/<([A-Za-z0-9_]+)(?:\s|>)/);
      let section = this.sanitizeKey(sectionMatch?.[1] || "values");
      // For <Content> tags, extract the section name from the <name> child element
      if (section === "content" || section === "navigation") {
        const nameMatch = xml.match(/<name>([\s\S]*?)<\/name>/);
        if (nameMatch) {
          section = this.sanitizeKey(nameMatch[1]);
        }
      }
      const itemRegex = /<item\b([^>]*)>([\s\S]*?)<\/item>/gi;

      for (const itemMatch of xml.matchAll(itemRegex)) {
        const attrs = itemMatch[1] || "";
        const idMatch = attrs.match(/\bid=["']([^"']+)["']/i);
        const itemId = idMatch?.[1] || "item";
        const body = itemMatch[2] || "";
        const nameMatch = body.match(/<name>([\s\S]*?)<\/name>/i);
        const rawLabel = nameMatch
          ? this.decodeXml(nameMatch[1] || itemId)
          : this.decodeXml((body.match(/^\s*([^<\t\r\n]{1,60})/)?.[1]?.trim() || itemId));
        const values = Array.from(body.matchAll(/<value>([\s\S]*?)<\/value>/gi));
        const raws = Array.from(body.matchAll(/<raw>([\s\S]*?)<\/raw>/gi));

        if (values.length === 0 && raws.length === 0) {
          continue;
        }

        let index = 0;
        for (const valueMatch of [...values, ...raws]) {
          const rawValue = this.decodeXml(valueMatch[1] || "").trim();
          if (!rawValue) {
            continue;
          }

          index += 1;
          const suffix = values.length > 1 ? `_${index}` : "";
          const key = `${section}_${this.sanitizeKey(rawLabel)}${suffix}`;
          if (this.shouldIgnoreKey(key)) {
            continue;
          }
          discoveredAny[key] = this.parseValue(rawValue);
        }
      }

      const genericTagRegex = /<([A-Za-z0-9_:-]+)[^>]*>([^<]{1,120})<\/\1>/g;
      for (const match of xml.matchAll(genericTagRegex)) {
        const tag = this.sanitizeKey(match[1] || "tag");
        const valueRaw = this.decodeXml(match[2] || "").trim();
        if (!valueRaw || this.shouldIgnoreKey(tag)) {
          continue;
        }
        const key = `${section}_${tag}`;
        if (!(key in discoveredAny)) {
          discoveredAny[key] = this.parseValue(valueRaw);
        }
      }

      const xmlText = this.xmlToText(xml);
      this.collectStructuredTextValues(xmlText, discoveredAny);
      const numericFallback: Record<string, number> = {};
      this.collectNumericTextValues(xmlText, numericFallback);
      for (const [key, value] of Object.entries(numericFallback)) {
        if (!(key in discoveredAny)) {
          discoveredAny[key] = value;
        }
      }
    }

    const discoveredValues: Record<string, number> = {};
    for (const [key, value] of Object.entries(discoveredAny)) {
      if (typeof value === "number" && Number.isFinite(value)) {
        discoveredValues[key] = value;
      }
    }

    return {
      discoveredValues,
      discoveredAny,
      rawPreview: messages.join("\n").slice(0, 3000),
    };
  }

  private extractRequestableItemIds(xml: string): string[] {
    const ids: string[] = [];
    for (const match of xml.matchAll(/<item\b[^>]*id=["']([^"']+)["']/gi)) {
      const id = match[1];
      if (!id || /^navigation$/i.test(id) || /^0x0x286b30$/i.test(id)) {
        continue;
      }
      ids.push(id);
    }

    return ids;
  }

  private extractNavigationTargets(xml: string): Array<{ id: string; name: string }> {
    if (!/<navigation/i.test(xml)) {
      return [];
    }

    const targets: Array<{ id: string; name: string }> = [];
    const regex = /<item\b[^>]*id=["']([^"']+)["'][^>]*>\s*<name>([^<]+)<\/name>/gi;
    for (const match of xml.matchAll(regex)) {
      const id = match[1];
      const name = this.decodeXml(match[2] || "").trim();
      if (!id || !name) {
        continue;
      }
      targets.push({ id, name });
    }

    return targets;
  }

  private hasMeasurementLikeKeys(values: Record<string, string | number | boolean>): boolean {
    const keys = Object.keys(values);
    if (keys.length === 0) {
      return false;
    }

    const signalHints = [
      "temperatur",
      "vorlauf",
      "ruecklauf",
      "rucklauf",
      "warmwasser",
      "waermequelle",
      "verdichter",
      "betriebsstunden",
      "waermemenge",
      "warmemenge",
      "eingaenge",
      "ausgaenge",
      "anlagenstatus",
    ];

    if (keys.some((key) => signalHints.some((hint) => key.includes(hint)))) {
      return true;
    }

    // Reject trivial navigation-only payloads.
    const nonTrivial = keys.filter((key) => !["navigation_name", "general_informationen"].includes(key));
    return nonTrivial.length >= 3;
  }

  private decodeXml(value: string): string {
    return value
      .replace(/&nbsp;/gi, " ")
      .replace(/&deg;/gi, "°")
      .replace(/&uuml;/gi, "ü")
      .replace(/&ouml;/gi, "ö")
      .replace(/&auml;/gi, "ä")
      .replace(/&Uuml;/g, "Ü")
      .replace(/&Ouml;/g, "Ö")
      .replace(/&Auml;/g, "Ä")
      .replace(/&szlig;/gi, "ß")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'");
  }

  private inferMeasurements(values: Record<string, string | number | boolean>): MeasurementMap {
    return {
      outdoorTemp: this.pickNumberFromDiscovered(values, ["aussentemperatur", "outdoor", "outside"]),
      flowTemp: this.pickNumberFromDiscovered(values, ["vorlauf", "flow"]),
      returnTemp: this.pickNumberFromDiscovered(values, ["ruecklauf", "rucklauf", "return"]),
    };
  }

  private pickNumberFromDiscovered(values: Record<string, string | number | boolean>, hints: string[]): number | undefined {
    for (const [key, value] of Object.entries(values)) {
      if (!hints.some((hint) => key.includes(hint))) {
        continue;
      }
      if (typeof value === "number" && Number.isFinite(value)) {
        return value;
      }
    }

    return undefined;
  }

  private extractMeasurements(raw: unknown): {
    measurements: MeasurementMap;
    discoveredValues: Record<string, number>;
    discoveredAny: Record<string, string | number | boolean>;
  } {
    const discoveredValues: Record<string, number> = {};
    const discoveredAny: Record<string, string | number | boolean> = {};

    if (typeof raw === "object" && raw !== null) {
      const obj = raw as Record<string, unknown>;
      this.collectNumericObjectValues(obj, discoveredValues);
      for (const [key, value] of Object.entries(discoveredValues)) {
        discoveredAny[`general_${key}`] = value;
      }
      return {
        measurements: {
          outdoorTemp: this.pickNumber(obj, ["outdoorTemp", "outsideTemp", "aussentemperatur", "AT"]),
          flowTemp: this.pickNumber(obj, ["flowTemp", "vorlauf", "Vorlauf"]),
          returnTemp: this.pickNumber(obj, ["returnTemp", "ruecklauf", "rucklauf", "Ruecklauf"]),
        },
        discoveredValues,
        discoveredAny,
      };
    }

    const text = String(raw || "");
    this.collectNumericTextValues(text, discoveredValues);
    this.collectStructuredTextValues(text, discoveredAny);
    for (const [key, value] of Object.entries(discoveredValues)) {
      if (!(key in discoveredAny)) {
        discoveredAny[key] = value;
      }
    }
    return {
      measurements: {
        outdoorTemp: this.extractByLabel(text, ["outdoor", "outside", "aussen", "aussentemperatur", "AT"]),
        flowTemp: this.extractByLabel(text, ["flow", "vorlauf"]),
        returnTemp: this.extractByLabel(text, ["return", "ruecklauf", "rucklauf"]),
      },
      discoveredValues,
      discoveredAny,
    };
  }

  private collectStructuredTextValues(text: string, target: Record<string, string | number | boolean>): void {
    const source = this.isLikelyHtml(text) ? this.htmlToTabularText(text) : text;
    const knownSections = new Set([
      "temperaturen",
      "eingange",
      "ausgange",
      "ablaufzeiten",
      "betriebsstunden",
      "fehlerspeicher",
      "abschaltungen",
      "anlagenstatus",
      "warmemenge",
      "glt",
    ]);

    let currentSection = "general";
    let eventIndex = 0;

    for (const rawLine of source.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }

      const normalizedHeading = this.sanitizeKey(line).replace(/ae/g, "a").replace(/oe/g, "o").replace(/ue/g, "u").replace(/ss/g, "s");
      if (knownSections.has(normalizedHeading)) {
        currentSection = normalizedHeading;
        continue;
      }
      if (/^heatpump\s+controller$/i.test(line)) {
        continue;
      }

      const parts = line.split(/\t+/).map((p) => p.trim()).filter(Boolean);
      if (parts.length >= 2) {
        const label = parts[0];
        const value = parts.slice(1).join(" ");
        const key = `${currentSection}_${this.sanitizeKey(label)}`;
        if (this.shouldIgnoreKey(key)) {
          continue;
        }
        target[key] = this.parseValue(value);
        continue;
      }

      if (/^\d{2}\.\d{2}\.\d{2}\s+\d{2}:\d{2}:\d{2}/.test(line)) {
        eventIndex += 1;
        target[`${currentSection}_event_${eventIndex}`] = line;
      }
    }
  }

  private parseValue(raw: string): string | number | boolean {
    const value = raw.trim();
    if (/^(ein|on|true)$/i.test(value)) {
      return true;
    }
    if (/^(aus|off|false)$/i.test(value)) {
      return false;
    }

    const numberWithUnit = value.match(/^(-?\d+(?:[.,]\d+)?)\s*(°c|v|kwh|l\/h|h)$/i);
    if (numberWithUnit?.[1]) {
      return Number(numberWithUnit[1].replace(",", "."));
    }

    if (/^-?\d+(?:[.,]\d+)?$/.test(value)) {
      return Number(value.replace(",", "."));
    }

    return value;
  }

  private collectNumericObjectValues(source: Record<string, unknown>, target: Record<string, number>, prefix = ""): void {
    for (const [rawKey, value] of Object.entries(source)) {
      const key = prefix ? `${prefix}_${rawKey}` : rawKey;
      if (typeof value === "number" && Number.isFinite(value)) {
        target[this.sanitizeKey(key)] = value;
        continue;
      }

      if (typeof value === "string") {
        const parsed = Number(value.replace(",", "."));
        if (Number.isFinite(parsed)) {
          target[this.sanitizeKey(key)] = parsed;
        }
        continue;
      }

      if (value && typeof value === "object") {
        this.collectNumericObjectValues(value as Record<string, unknown>, target, key);
      }
    }
  }

  private collectNumericTextValues(text: string, target: Record<string, number>): void {
    const regex = /([A-Za-z0-9_\-./]{2,40})[^\d\-]{1,20}(-?\d+(?:[.,]\d+)?)/g;
    for (const match of text.matchAll(regex)) {
      const rawKey = match[1];
      const rawValue = match[2];
      if (!rawKey || !rawValue) {
        continue;
      }

      const value = Number(rawValue.replace(",", "."));
      if (!Number.isFinite(value)) {
        continue;
      }

      const key = this.sanitizeKey(rawKey);
      if (this.shouldIgnoreKey(key)) {
        continue;
      }
      target[key] = value;
    }
  }

  private sanitizeKey(value: string): string {
    const normalized = value
      .trim()
      .replace(/[äÄ]/g, "ae")
      .replace(/[öÖ]/g, "oe")
      .replace(/[üÜ]/g, "ue")
      .replace(/ß/g, "ss")
      .replace(/\s+/g, "_")
      .replace(/[^A-Za-z0-9_\-.]/g, "_")
      .toLowerCase();
    const result = normalized.replace(/_+/g, "_").slice(0, 80) || "value";
    // Remove trailing dots and underscores from state IDs
    return result.replace(/[._]+$/, "") || "value";
  }

  private shouldIgnoreKey(key: string): boolean {
    const junkParts = [
      "html",
      "head",
      "body",
      "title",
      "viewport",
      "initial-scale",
      "maximum-scale",
      "minimum-scale",
      "text_html",
      "meta",
      "doctype",
      "script",
      "stylesheet",
      "favicon",
      "nav",
      "menu",
    ];
    return junkParts.some((part) => key.includes(part));
  }

  private isLikelyHtml(value: string): boolean {
    return /<html|<body|<table|<!doctype\s+html/i.test(value);
  }

  private isMeaningfulDiscovery(values: Record<string, string | number | boolean>): boolean {
    const keys = Object.keys(values).filter((key) => !this.shouldIgnoreKey(key));
    if (keys.length >= 6) {
      return true;
    }

    const hints = ["vorlauf", "ruecklauf", "aussentemperatur", "warmwasser", "verdichter", "waermequelle"];
    return keys.some((key) => hints.some((hint) => key.includes(hint)));
  }

  private extractHtmlLinks(html: string, baseUrl: string): string[] {
    const links = new Set<string>();
    const regex = /href=["']([^"']+)["']/gi;

    for (const match of html.matchAll(regex)) {
      const raw = match[1];
      if (!raw) {
        continue;
      }

      if (/^(javascript:|mailto:|#)/i.test(raw)) {
        continue;
      }
      if (/\.(?:js|css|png|jpe?g|gif|svg|ico|webp)(?:\?|$)/i.test(raw)) {
        continue;
      }
      if (/jquery|bootstrap|lodash|moment|angular|react/i.test(raw)) {
        continue;
      }

      const absolute = this.toAbsoluteUrl(baseUrl, raw);
      if (absolute.startsWith(baseUrl)) {
        links.add(absolute);
      }
    }

    return Array.from(links).slice(0, 30);
  }

  private looksLikeLibrarySource(url: string, content: string): boolean {
    if (/\.(?:js|css)(?:\?|$)/i.test(url)) {
      return true;
    }
    if (/jquery|bootstrap|lodash|moment|angular|react/i.test(url)) {
      return true;
    }

    const text = content.slice(0, 2000);
    if (/^\s*\/\*[!*]/.test(text)) {
      return true;
    }
    return /jQuery\s+v\d|function\(a,b\)\{"object"==typeof module|Sizzle|n\.fn\.init/i.test(text);
  }

  private toAbsoluteUrl(baseUrl: string, inputUrl: string): string {
    if (/^https?:\/\//i.test(inputUrl)) {
      return inputUrl;
    }

    if (inputUrl.startsWith("/")) {
      return `${baseUrl}${inputUrl}`;
    }

    return `${baseUrl}/${inputUrl}`;
  }

  private htmlToTabularText(html: string): string {
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/tr>/gi, "\n")
      .replace(/<\/t[dh]>/gi, "\t")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&deg;/gi, "°")
      .replace(/&uuml;/gi, "ü")
      .replace(/&ouml;/gi, "ö")
      .replace(/&auml;/gi, "ä")
      .replace(/&szlig;/gi, "ß")
      .replace(/&amp;/gi, "&");
  }

  private xmlToText(xml: string): string {
    return this.decodeXml(
      xml
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<\/item>/gi, "\n")
        .replace(/<\/value>/gi, "\t")
        .replace(/<\/name>/gi, "\t")
        .replace(/<\/raw>/gi, "\t")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/[ \f\r\v]+/g, " ")
        .replace(/\t+/g, "\t")
        .replace(/\n+/g, "\n")
    );
  }

  private async syncDynamicLuxStates(discoveredData: Record<string, string | number | boolean>): Promise<void> {
    // Group data by section (e.g., "temperaturen", "eingaenge", "ausgaenge")
    const grouped: Record<string, Record<string, string | number | boolean>> = {};

    for (const [key, value] of Object.entries(discoveredData)) {
      const parts = key.split("_");
      if (parts.length < 2) continue;

      const section = parts[0]; // e.g., "temperaturen"
      let itemName = parts.slice(1).join("_"); // e.g., "vorlauf"
      // Trim trailing dots/underscores from item names
      itemName = itemName.replace(/[._]+$/, "");
      if (!itemName) continue;

      if (!grouped[section]) {
        grouped[section] = {};
      }
      grouped[section][itemName] = value;
    }

    // For each section, create channel and states
    for (const [section, items] of Object.entries(grouped)) {
      if (Object.keys(items).length === 0) continue;

      // Create channel
      const channelName = this.getChannelName(section);
      await this.extendObjectAsync(section, {
        type: "channel",
        common: { name: channelName },
        native: {},
      });

      // Create states for each item
      for (const [itemName, value] of Object.entries(items)) {
        const stateId = `${section}.${itemName}`;
        const valueType = typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "string";
        const role = this.getStateRole(section, itemName, valueType);
        const unit = this.getStateUnit(section, itemName, value);

        try {
          await this.extendObjectAsync(stateId, {
            type: "state",
            common: {
              name: this.humanizeLabel(itemName),
              type: valueType,
              role: role,
              unit: unit,
              read: true,
              write: false,
            },
            native: {},
          });

          // Convert value to proper type
          let stateValue: ioBroker.StateValue = value;
          if (valueType === "number" && typeof value !== "number") {
            stateValue = Number(value);
            if (isNaN(stateValue)) {
              this.log.debug(`Skipping ${stateId}: cannot convert "${value}" to number`);
              continue;
            }
          } else if (valueType === "boolean" && typeof value !== "boolean") {
            stateValue = value === "true" || value === "1" || value === 1;
          } else if (valueType === "string") {
            stateValue = String(value);
          }

          await this.setStateAsync(stateId, stateValue, true);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.log.warn(`Failed to set state ${stateId}: ${msg}`);
        }
      }
    }
  }

  private getChannelName(section: string): string {
    const names: Record<string, string> = {
      temperaturen: "Temperaturen",
      eingaenge: "Eingänge",
      ausgaenge: "Ausgänge",
      ablaufzeiten: "Ablaufzeiten",
      betriebsstunden: "Betriebsstunden",
      energien: "Energien",
      energie: "Energie",
      fehlergeschichte: "Fehlergeschichte",
      anlagenstatus: "Anlagenstatus",
    };
    return names[section] || this.humanizeLabel(section);
  }

  private getStateRole(section: string, itemName: string, valueType: string): string {
    if (section.includes("temperatur") || itemName.includes("temperatur")) {
      return "value.temperature";
    }
    if (section.includes("energie") || section.includes("betrieb")) {
      return valueType === "number" ? "value.power.consumption" : "text";
    }
    if (section.includes("ausgaenge") && valueType === "boolean") {
      return "indicator";
    }
    if (section.includes("eingaenge") && valueType === "boolean") {
      return "sensor";
    }
    return valueType === "boolean" ? "indicator" : "text";
  }

  private getStateUnit(section: string, itemName: string, value: string | number | boolean): string | undefined {
    if (typeof value === "number") {
      if (section.includes("temperatur") || itemName.includes("temperatur")) {
        return "degC";
      }
      if (section.includes("energie") || section.includes("warmemenge") || section.includes("waermemenge")) {
        return "kWh";
      }
      if (section.includes("betrieb") && itemName.includes("stunden")) {
        return "h";
      }
    }
    return undefined;
  }

  private humanizeLabel(key: string): string {
    return key
      .split("_")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }

  private limitText(value: string, maxLen: number): string {
    if (value.length <= maxLen) {
      return value;
    }

    return `${value.slice(0, maxLen)}...`;
  }

  private pickNumber(source: Record<string, unknown>, keys: string[]): number | undefined {
    for (const key of keys) {
      if (key in source) {
        const value = Number(String(source[key]).replace(",", "."));
        if (Number.isFinite(value)) {
          return value;
        }
      }
    }

    return undefined;
  }

  private extractByLabel(text: string, labels: string[]): number | undefined {
    for (const label of labels) {
      const regex = new RegExp(`${label}[^0-9-]*(-?\\d+(?:[.,]\\d+)?)`, "i");
      const match = text.match(regex);
      if (match?.[1]) {
        const parsed = Number(match[1].replace(",", "."));
        if (Number.isFinite(parsed)) {
          return parsed;
        }
      }
    }

    return undefined;
  }

  private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
    if (state && !state.ack) {
      this.log.debug(`State ${id} changed by user: ${JSON.stringify(state.val)}`);
    }
  }

  private onUnload(callback: () => void): void {
    try {
      callback();
    } catch {
      callback();
    }
  }
}

if (require.main !== module) {
  module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new AlphainnotecAdapter(options);
} else {
  (() => new AlphainnotecAdapter())();
}
