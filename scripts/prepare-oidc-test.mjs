// Generate ephemeral test keys locally. Nothing here is a production credential.
import { generateKeyPair, exportJWK } from "jose";
import { mkdir, writeFile } from "node:fs/promises";
const { privateKey, publicKey } = await generateKeyPair("RS256", {
  extractable: true,
});
const publicJwk = {
  ...(await exportJWK(publicKey)),
  kid: "mujez-test",
  use: "sig",
  alg: "RS256",
};
const privateJwk = await exportJWK(privateKey);
await mkdir(new URL("../tests/.generated/", import.meta.url), {
  recursive: true,
});
await writeFile(
  new URL("../tests/.generated/private-jwk.json", import.meta.url),
  JSON.stringify(privateJwk),
  { mode: 0o600 },
);
const handler = `// Generated ephemeral JWKS test provider. Run npm run test:oidc:prepare to regenerate.
const http = require('http');
const jwks = ${JSON.stringify({ keys: [publicJwk] })};
http.createServer((req,res) => {
  res.setHeader('Content-Type','application/json');
  if (req.method === 'GET' && req.url.split('?')[0] === '/jwks') {
    res.writeHead(200); res.end(JSON.stringify(jwks));
  } else {res.writeHead(501);res.end(JSON.stringify({code:'not_modeled'}));}
}).listen(process.env.PORT);
`;
await writeFile(
  new URL("../postman/mocks/oidc/default.js", import.meta.url),
  handler,
);
console.log("Ephemeral OIDC simulation fixtures prepared");
