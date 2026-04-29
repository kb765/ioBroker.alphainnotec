"use strict";

const startAdapter = require("./dist/main.js");

if (typeof startAdapter === "function") {
	startAdapter();
} else if (startAdapter && typeof startAdapter.default === "function") {
	startAdapter.default();
}
