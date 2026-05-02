const http = require("http");
const fs = require("fs");
const path = require("path");

const rootDir = __dirname;
const port = process.env.PORT || 4173;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".ts": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

function resolveRequestPath(requestUrl) {
  const safeUrl = new URL(requestUrl, `http://localhost:${port}`);
  const requestedPath = safeUrl.pathname === "/" ? "/index.html" : safeUrl.pathname;
  return path.normalize(path.join(rootDir, requestedPath));
}

const server = http.createServer((request, response) => {
  const filePath = resolveRequestPath(request.url);

  if (!filePath.startsWith(rootDir)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(error.code === "ENOENT" ? 404 : 500);
      response.end(error.code === "ENOENT" ? "Not found" : "Server error");
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    response.writeHead(200, {
      "Content-Type": mimeTypes[extension] || "application/octet-stream",
    });
    response.end(content);
  });
});

server.listen(port, () => {
  console.log(`Burr Puzzle MVP running at http://localhost:${port}`);
});
