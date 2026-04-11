import { io, Socket } from "socket.io-client";

const SOCKET_ADDR = "ws://127.0.0.1:5000";

type BgRequest =
    | { type: "socket:register" }
    | { type: "socket:connect" }
    | { type: "socket:emit"; requestId: string; event: string; data: any }
    | { type: "fetch"; url: string; init: RequestInit };

type BgResponse =
    | { ok: true; data?: any }
    | { ok: false; error: string }
    | { data: Promise<Response> };

let socket: Socket | null = null;
let connecting: Promise<Socket> | null = null;

function pushToMain(event: string, data: any) {
    chrome.runtime.sendMessage({ type: "socket:event", event, data });
}

function attachSocketListeners(s: Socket) {
    s.on("connect", () => {
        pushToMain("log", "[background] connected to localhost socket\n");
    });

    s.on("disconnect", (reason) => {
        pushToMain("log", `[background] disconnected: ${reason}\n`);
    });

    s.on("log", (data) => {
        pushToMain("log", String(data));
    });
}

function ensureSocket(): Promise<Socket> {
    if (socket?.connected) return Promise.resolve(socket);
    if (connecting) return connecting;

    connecting = new Promise<Socket>((resolve, reject) => {
        const s = io(SOCKET_ADDR, {
            transports: ["websocket", "polling"],
        });

        socket = s;
        attachSocketListeners(s);

        s.once("connect", () => resolve(s));
        s.once("connect_error", (err) => reject(err));
    }).finally(() => {
        connecting = null;
    });

    return connecting;
}

chrome.runtime.onMessage.addListener(
    (msg: BgRequest, _sender, sendResponse) => {
        if (!msg || typeof msg !== "object") return;

        if (msg.type === "socket:register") {
            ensureSocket()
                .then(() => sendResponse({ ok: true } satisfies BgResponse))
                .catch((err) =>
                    sendResponse({
                        ok: false,
                        error: String(err),
                    } satisfies BgResponse)
                );
            return true;
        }

        if (msg.type === "socket:connect") {
            ensureSocket()
                .then(() => sendResponse({ ok: true } satisfies BgResponse))
                .catch((err) =>
                    sendResponse({
                        ok: false,
                        error: String(err),
                    } satisfies BgResponse)
                );
            return true;
        }

        if (msg.type === "socket:emit") {
            ensureSocket()
                .then((s) => {
                    s.emit(msg.event, msg.data, (response: any) => {
                        sendResponse({ ok: true, data: response } satisfies BgResponse);
                    });
                })
                .catch((err) =>
                    sendResponse({
                        ok: false,
                        error: String(err),
                    } satisfies BgResponse)
                );
            return true;
        }

        if (msg.type == "fetch") {
            fetch(msg.url, msg.init)
                .then(async (response) => {
                    sendResponse({
                        ok: true,
                        data: {
                            status: response.status,
                            statusText: response.statusText,
                            headers: Object.fromEntries(response.headers.entries()),
                            ok: response.status == 200,
                            body: await response.json()
                        }
                    } satisfies BgResponse);
                })
                .catch((err) => {
                    sendResponse({
                        ok: false,
                        error: String(err)
                    } satisfies BgResponse);
                });
            return true;
        }
    }
);