import http from "node:http"
import express from "express"
import path from "node:path"
import jwt from "jsonwebtoken"
import { createPublicKey } from "node:crypto"
import { publisher, subscriber } from "./redis-connection.js"

import { Server } from "socket.io"

const AUTH_ORIGIN = process.env.AUTH_ORIGIN || "https://auth.pallabdev.in";
const AUTH_CLIENT_ID = process.env.AUTH_CLIENT_ID || "";
const AUTH_CLIENT_SECRET = process.env.AUTH_CLIENT_SECRET || "";
const JWKS_URL = `${AUTH_ORIGIN}/certs`;
const TOKEN_URL = `${AUTH_ORIGIN}/token`;
const CHECKBOX_COUNT = Number(process.env.CHECKBOX_COUNT || 500);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 3000);
const CHECKBOX_STATE_KEY = "checkbox:state";
const CHECKBOX_CHANGE_CHANNEL = "checkbox:change";
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

function getRedirectUri(req) {
    return process.env.AUTH_REDIRECT_URI || `${req.protocol}://${req.get("host")}/auth`;
}

function getAuthCredentials() {
    if (!AUTH_CLIENT_ID || !AUTH_CLIENT_SECRET) {
        throw new Error("AUTH_CLIENT_ID and AUTH_CLIENT_SECRET must be set");
    }

    return {
        clientId: AUTH_CLIENT_ID,
        clientSecret: AUTH_CLIENT_SECRET
    };
}

async function main() {
    const app = express();
    const rateLimitingHashMap = new Map();
    const server = http.createServer(app);
    const PORT = process.env.PORT || 8000;
    const serverId = `${process.pid}-${Date.now()}`;
    app.set("trust proxy", true);
    app.use(express.json());
    app.get('/health', (req, res) => {
        res.json({
            health: true
        });
    });

    const savedCheckboxes = await publisher.hgetall(CHECKBOX_STATE_KEY);
    const checkboxes = new Array(CHECKBOX_COUNT).fill(false);

    for (const [index, checked] of Object.entries(savedCheckboxes)) {
        const numericIndex = Number(index);

        if (Number.isInteger(numericIndex) && numericIndex >= 0 && numericIndex < CHECKBOX_COUNT) {
            checkboxes[numericIndex] = checked === "true";
        }
    }

    const io = new Server();
    io.attach(server);
    await subscriber.subscribe(CHECKBOX_CHANGE_CHANNEL);
    subscriber.on("message", (channel, message) => {
        if (channel === CHECKBOX_CHANGE_CHANNEL) {
            const { index, checked, user, originServerId } = JSON.parse(message);

            if (originServerId === serverId) {
                return;
            }

            checkboxes[index] = checked;
            io.emit("server:checkbox:change", {
                index,
                checked
            });
            io.emit("server:checkbox:user", { user });
        }
    });
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
                if (lastOperationTime + RATE_LIMIT_WINDOW_MS > Date.now()) {
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
            await publisher.hset(CHECKBOX_STATE_KEY, String(data.index), String(data.checked));
            io.emit("server:checkbox:change", {
                index: data.index,
                checked: data.checked
            });
            await publisher.publish(CHECKBOX_CHANGE_CHANNEL, JSON.stringify({
                index: data.index,
                checked: data.checked,
                user: validUser.name,
                originServerId: serverId
            }));
            socket.broadcast.emit("server:checkbox:user", { user: validUser.name });
        });
    });

    app.get('/login', (req, res) => {
        try {
            const { clientId } = getAuthCredentials();
            const loginUrl = new URL("/user/login", AUTH_ORIGIN);

            loginUrl.searchParams.set("client_id", clientId);
            loginUrl.searchParams.set("redirect_uri", getRedirectUri(req));
            res.redirect(loginUrl.toString());
        } catch (error) {
            res.status(500).send(error.message);
        }
    });

    app.post('/auth/exchange', async (req, res) => {
        const code = req.body?.code;

        if (!code) {
            res.status(400).json({ message: "Missing authorization code." });
            return;
        }

        try {
            const { clientId, clientSecret } = getAuthCredentials();
            const tokenResponse = await fetch(TOKEN_URL, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    clientId,
                    clientSecret,
                    code,
                    redirectUri: getRedirectUri(req)
                })
            });
            const tokenData = await tokenResponse.json();

            if (!tokenResponse.ok || !tokenData?.data?.accessToken) {
                throw new Error(tokenData?.message || "Unable to complete authentication.");
            }

            res.json({
                accessToken: tokenData.data.accessToken
            });
        } catch (error) {
            res.status(500).json({
                message: error.message || "Authentication failed."
            });
        }
    });

    app.get('/', (req, res) => {
        res.sendFile(path.resolve('./public/login.html'))
    });

    app.get("/home", (req, res) => {
        res.sendFile(path.resolve('./public/index.html'))
    });

    app.get('/auth', async (req, res) => {
        res.sendFile(path.resolve('./public/auth.html'))
    });
    server.listen(PORT, () => {
        console.log(`server is running on http://localhost:${PORT}`);
    });

}
main();
