import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import handler from "./api/stream.ts";

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(process.cwd(), "public");

const server = http.createServer(async (req, res) => {
  const host = req.headers.host || `localhost:${PORT}`;
  const parsedUrl = new URL(req.url || "/", `http://${host}`);
  const pathname = parsedUrl.pathname;

  // Add Vercel compatibility helpers
  (res as any).status = function (statusCode: number) {
    this.statusCode = statusCode;
    return this;
  };

  (res as any).json = function (data: any) {
    this.setHeader("Content-Type", "application/json; charset=utf-8");
    this.end(JSON.stringify(data, null, 2));
    return this;
  };

  // Populate req.query
  const query: Record<string, string> = {};
  for (const [key, value] of parsedUrl.searchParams.entries()) {
    query[key] = value;
  }
  (req as any).query = query;

  // Serve landing page with live player and documentation
  if (pathname === "/" || pathname === "/index.html") {
    const indexPath = path.join(PUBLIC_DIR, "index.html");
    if (fs.existsSync(indexPath)) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(fs.readFileSync(indexPath, "utf-8"));
      return;
    }
  }

  // Route /api/stream
  if (pathname === "/api/stream") {
    try {
      await handler(req, res);
    } catch (err: any) {
      console.error("Unhandled handler error:", err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "Internal Server Error", message: err?.message }));
      }
    }
    return;
  }

  // 404 for other routes
  res.statusCode = 404;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ error: "Not Found", path: pathname }));
});

let currentPort = PORT;

function startServer(port: number) {
  server.listen(port, () => {
    console.log(`\n======================================================`);
    console.log(`🚀 YouTube Live Stream Server running at: http://localhost:${port}`);
    console.log(`======================================================\n`);
  });
}

server.on("error", (err: any) => {
  if (err.code === "EADDRINUSE") {
    console.warn(`⚠️ Port ${currentPort} is in use. Trying port ${currentPort + 1}...`);
    currentPort += 1;
    startServer(currentPort);
  } else {
    console.error("Server error:", err);
  }
});

startServer(currentPort);
