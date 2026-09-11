// Local-only QA server. No dependencies, no production OAuth tokens or Twitch traffic.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, resolve, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mime = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png" };
const server = http.createServer(async (request, response) => {
    try {
        const url = new URL(request.url, "http://127.0.0.1");
        const pathname = url.pathname === "/" ? "/tests/analytics-browser.html" : decodeURIComponent(url.pathname);
        const file = resolve(root, `.${pathname}`);
        if (request.method !== "GET" || !file.startsWith(root + sep) || !mime[extname(file)]) { response.writeHead(404); response.end(); return; }
        response.writeHead(200, { "Content-Type": `${mime[extname(file)]}; charset=utf-8`, "Cache-Control": "no-store" });
        let content = await readFile(file);
        if (url.pathname === "/popup.html" && url.searchParams.has("fixture")) {
            content = content.toString().replace('src="popup.js"', 'src="tests/popup-fixture.js"');
        }
        response.end(content);
    } catch (_) { response.writeHead(404); response.end(); }
});
server.listen(4173, "127.0.0.1", () => console.log("Analytics QA: http://127.0.0.1:4173/tests/analytics-browser.html"));
