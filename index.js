import http from "node:http"
import express from "express"
import path from "node:path"
import jwt from "jsonwebtoken"
import { createPublicKey } from "node:crypto"


import { Server } from "socket.io"

const JWKS_URL = "https://auth.pallabdev.in/certs";
let cachedJwks = null;
let cachedJwksExpiresAt = 0;

async function getJwks() {
    if (cachedJwks && cachedJwksExpiresAt > Date.now()) {
        return cachedJwks;
    }

    const response = await fetch(JWKS_URL);
    if (!response.ok) {
        throw new Error(`Unable to fetch JWKS: ${response.status}`);
    }
    cachedJwks = await response.json();
    cachedJwksExpiresAt = Date.now() + 5 * 60 * 1000;
    return cachedJwks;
}

async function validateAccessToken(accessToken) {
    if (!accessToken || typeof accessToken !== "string") {
        throw new Error("Missing access token");
    }

    const header = jwt.decode(accessToken, { complete: true })?.header;

    if (header?.alg !== "RS256") {
        throw new Error("Unsupported token algorithm");
    }

    const jwks = await getJwks();
    const jwk = jwks?.keys?.find((key) =>
        key.kty === "RSA" &&
        key.use === "sig" &&
        key.alg === "RS256" &&
        (!header?.kid || key.kid === header.kid)
    );

    if (!jwk) {
        throw new Error("Signing key not found");
    }

    return jwt.verify(accessToken, createPublicKey({ key: jwk, format: "jwk" }), {
        algorithms: ["RS256"]
    });
}

async function main() {
    const app = express();
    const rateLimitingHashMap = new Map();
    const server = http.createServer(app);
    const PORT = process.env.PORT || 8000;
    app.get('/health', (req, res) => {
        res.json({
            health: true
        });
    });

    const CHECKBOX_COUNT = 500;
    const checkboxes = new Array(CHECKBOX_COUNT).fill(null);




    const io = new Server();
    io.attach(server);
    // socket handler
    io.on('connection', (socket) => {
        console.log("Socket connected", { id: socket.id });
        socket.emit("server:checkbox:status", checkboxes);

        socket.on("client:checkbox:change", async (data) => {
            // console.log(`Received checkbox change from client: ${socket.id}, Data:`, data);
            // console.log(data.accessToken);
            let validUser;
            try {
                validUser = await validateAccessToken(data.accessToken);
                console.log("Valid user", validUser)

            } catch (error) {
                socket.emit("server:error", { data, message: error.message || "Invalid access token" });
                return;
            }
            let lastOperationTime = rateLimitingHashMap.get(validUser.id);
            if (lastOperationTime) {
                if (lastOperationTime + 3000 > Date.now()) {
                    socket.emit("server:error", { data, message: "You are doing that too much. Please wait a moment before trying again." });
                    return;
                }
                else {
                    rateLimitingHashMap.set(validUser.id, Date.now());
                }
            }
            else {
                rateLimitingHashMap.set(validUser.id, Date.now());
            }
            checkboxes[data.index] = data.checked;
            io.emit("server:checkbox:change", {
                index: data.index,
                checked: data.checked
            });
            socket.broadcast.emit("server:checkbox:user", { user: validUser.name });
        })
    })


    // Express handler 
    // app.use(express.static(path.resolve('./public')))

    app.get('/', (req, res) => {
        res.sendFile(path.resolve('./public/login.html'))
    })

    app.get("/home", (req, res) => {
        res.sendFile(path.resolve('./public/index.html'))
    })

    // /home


    app.get('/auth', async (req, res) => {
        res.sendFile(path.resolve('./public/auth.html'))
    })
    server.listen(PORT, () => {
        console.log(`server is running on http://localhost:${PORT}`);
    })

}
main();
