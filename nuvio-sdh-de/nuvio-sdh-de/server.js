// Local test server: node server.js  ->  http://localhost:3000/manifest.json
const http = require("http");
const handler = require("./api/index.js");

http.createServer(handler).listen(process.env.PORT || 3000, () => {
  console.log(`Addon running on http://localhost:${process.env.PORT || 3000}/manifest.json`);
});
