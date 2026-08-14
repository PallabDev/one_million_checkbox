import http from "node:http"
import express from "express"
import path from "node:path"
import jwt from "jsonwebtoken"
import crypto from "node:crypto"
import { publisher, subscriber } from "./redis-connection.js"

import { Server } from "socket.io"

const JWT_SECRET = process.env.JWT_SECRET || "default-fallback-super-secret-key-12345";
const CHECKBOX_COUNT = Number(process.env.CHECKBOX_COUNT || 500);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 3000);
const CHECKBOX_STATE_KEY = "checkbox:state";
const CHECKBOX_CHANGE_CHANNEL = "checkbox:change";

function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, "sha512").toString("hex");
    return `${salt}:${hash}`;
}

function verifyPassword(password, storedPassword) {
    const parts = storedPassword.split(":");
    if (parts.length !== 2) return false;
    const [salt, originalHash] = parts;
    const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, "sha512").toString("hex");
    return hash === originalHash;
}

async function validateAccessToken(accessToken) {
    if (!accessToken || typeof accessToken !== "string") {
        throw new Error("Missing access token");
    }
    return jwt.verify(accessToken, JWT_SECRET);
}

async function main() {
    const app = express();
    const rateLimitingHashMap = new Map();
    const server = http.createServer(app);
    const PORT = process.env.PORT || 6798;
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

    // Register route
    app.post('/auth/register', async (req, res) => {
        const { username, password } = req.body;
        if (!username || !password) {
            res.status(400).json({ message: "Username and password are required." });
            return;
        }
        if (username.length < 3 || password.length < 6) {
            res.status(400).json({ message: "Username must be at least 3 characters and password at least 6 characters." });
            return;
        }

        try {
            const normalizedUsername = username.trim().toLowerCase();
            // Check if user already exists
            const exists = await publisher.exists(`user:${normalizedUsername}`);
            if (exists) {
                res.status(409).json({ message: "Username is already taken." });
                return;
            }

            // Save user in Redis
            const hashedPassword = hashPassword(password);
            await publisher.hset(`user:${normalizedUsername}`, {
                username: normalizedUsername,
                password: hashedPassword,
                createdAt: Date.now()
            });

            res.status(201).json({ message: "Registration successful." });
        } catch (error) {
            res.status(500).json({ message: error.message || "Registration failed." });
        }
    });

    // Login route
    app.post('/auth/login', async (req, res) => {
        const { username, password } = req.body;
        if (!username || !password) {
            res.status(400).json({ message: "Username and password are required." });
            return;
        }

        try {
            const normalizedUsername = username.trim().toLowerCase();
            const user = await publisher.hgetall(`user:${normalizedUsername}`);
            if (!user || !user.password) {
                res.status(401).json({ message: "Invalid username or password." });
                return;
            }

            const isValid = verifyPassword(password, user.password);
            if (!isValid) {
                res.status(401).json({ message: "Invalid username or password." });
                return;
            }

            // Issue access token (expires in 15 minutes) and refresh token (expires in 7 days)
            const accessToken = jwt.sign(
                { id: normalizedUsername, name: username.trim() },
                JWT_SECRET,
                { expiresIn: '15m' }
            );

            const refreshToken = crypto.randomBytes(32).toString('hex');
            // Store refresh token in Redis (7 days TTL: 604800 seconds)
            await publisher.set(`refresh_token:${refreshToken}`, username.trim(), 'EX', 7 * 24 * 60 * 60);

            res.json({
                accessToken,
                refreshToken
            });
        } catch (error) {
            res.status(500).json({ message: error.message || "Login failed." });
        }
    });

    // Refresh token route
    app.post('/auth/refresh', async (req, res) => {
        const { refreshToken } = req.body;
        if (!refreshToken) {
            res.status(400).json({ message: "Refresh token is required." });
            return;
        }

        try {
            const originalUsername = await publisher.get(`refresh_token:${refreshToken}`);
            if (!originalUsername) {
                res.status(401).json({ message: "Invalid or expired refresh token." });
                return;
            }

            // Delete old refresh token (rotation)
            await publisher.del(`refresh_token:${refreshToken}`);

            // Issue new tokens
            const normalizedUsername = originalUsername.trim().toLowerCase();
            const newAccessToken = jwt.sign(
                { id: normalizedUsername, name: originalUsername },
                JWT_SECRET,
                { expiresIn: '15m' }
            );

            const newRefreshToken = crypto.randomBytes(32).toString('hex');
            await publisher.set(`refresh_token:${newRefreshToken}`, originalUsername, 'EX', 7 * 24 * 60 * 60);

            res.json({
                accessToken: newAccessToken,
                refreshToken: newRefreshToken
            });
        } catch (error) {
            res.status(500).json({ message: error.message || "Refresh failed." });
        }
    });

    // Logout route
    app.post('/auth/logout', async (req, res) => {
        const { refreshToken } = req.body;
        if (refreshToken) {
            try {
                await publisher.del(`refresh_token:${refreshToken}`);
            } catch (error) {
                console.error("Error deleting refresh token during logout:", error);
            }
        }
        res.json({ message: "Logged out successfully." });
    });

    app.get('/', (req, res) => {
        res.sendFile(path.resolve('./public/login.html'))
    });

    app.get("/home", (req, res) => {
        res.sendFile(path.resolve('./public/index.html'))
    });
    server.listen(PORT, () => {
        console.log(`server is running on http://localhost:${PORT}`);
    });

}
main();
