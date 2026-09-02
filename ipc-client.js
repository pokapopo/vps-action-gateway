"use strict";

const net = require("node:net");
const crypto = require("node:crypto");

function callBackend(socketPath, action, args = {}, timeoutMs = 35_000) {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const socket = net.createConnection(socketPath);
    let buffer = "";
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };

    const timer = setTimeout(() => finish(new Error("backend timeout")), timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ request_id: requestId, action, arguments: args })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        if (response.request_id !== requestId) throw new Error("backend request id mismatch");
        finish(null, response);
      } catch (error) {
        finish(error);
      }
    });
    socket.on("error", (error) => finish(error));
    socket.on("end", () => {
      if (!settled) finish(new Error("backend closed without a response"));
    });
  });
}

module.exports = { callBackend };
