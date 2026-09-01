const WebSocket = require("ws");
const EventEmitter = require("events");
const { login, USER_AGENT } = require("./session");

// Platforms VRChat reports on friend-online events.
// "standalonewindows" = PC desktop or PCVR client (this is "actually in VRChat")
// "android"           = Quest/Pico standalone VRChat *app* -- this also covers people
//                        using the real VRChat app on a headset, so it is NOT the same
//                        thing as "the mobile companion app". VRChat's API does not
//                        currently expose a separate flag for the phone companion app,
//                        because the companion app doesn't trigger friend-online at all
//                        (it only ever shows you as "active" on the website, which is the
//                        separate friend-active event we ignore entirely below).
const DEFAULT_ALLOWED_PLATFORMS = ["standalonewindows", "android"];

class VRChatClient extends EventEmitter {
  constructor({ username, password, allowedPlatforms = DEFAULT_ALLOWED_PLATFORMS } = {}) {
    super();
    this.username = username;
    this.password = password;
    this.allowedPlatforms = allowedPlatforms;
    this.client = null;
    this.jar = null;
    this.me = null;
    this.ws = null;
    this._reconnectDelay = 5000;
  }

  async init() {
    const { client, jar, user } = await login({ username: this.username, password: this.password });
    this.client = client;
    this.jar = jar;
    this.me = user;
    return user;
  }

  // Full friends list (id + displayName), online or not, so you can pick who to watch.
  async getFriendsList() {
    const all = [];
    for (const offline of [false, true]) {
      let offset = 0;
      const n = 100;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const res = await this.client.get("/auth/user/friends", {
          params: { offline, n, offset },
        });
        const batch = res.data || [];
        all.push(...batch);
        if (batch.length < n) break;
        offset += n;
      }
    }
    return all.map((f) => ({ id: f.id, displayName: f.displayName }));
  }

  async _getAuthCookieValue() {
    const cookies = await this.jar.getCookies("https://api.vrchat.cloud");
    console.log("[vrchat][debug] cookies visible for api.vrchat.cloud:", JSON.stringify(cookies.map((c) => ({ key: c.key, domain: c.domain, path: c.path }))));
    // Fallback: dump every cookie in the jar regardless of domain, in case
    // VRChat is scoping the cookie somewhere unexpected.
    const allCookies = await this.jar.getCookies("https://api.vrchat.cloud", { allPaths: true });
    if (allCookies.length === 0) {
      const serialized = this.jar.toJSON();
      console.log("[vrchat][debug] full jar contents:", JSON.stringify(serialized));
    }
    const authCookie = cookies.find((c) => c.key === "auth");
    if (!authCookie) throw new Error("No auth cookie found after login.");
    return authCookie.value;
  }

  async connectRealtime() {
    const authToken = await this._getAuthCookieValue();
    const url = `wss://pipeline.vrchat.cloud/?authToken=${authToken}`;
    this.ws = new WebSocket(url, { headers: { "User-Agent": USER_AGENT } });

    this.ws.on("open", () => {
      this._reconnectDelay = 5000;
      this.emit("connected");
      console.log("[vrchat] Realtime pipeline connected.");
    });

    this.ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      this._handlePipelineMessage(msg);
    });

    this.ws.on("close", (code) => {
      console.warn(`[vrchat] Pipeline closed (code ${code}). Reconnecting in ${this._reconnectDelay / 1000}s...`);
      this.emit("disconnected");
      setTimeout(() => this._reconnect(), this._reconnectDelay);
      this._reconnectDelay = Math.min(this._reconnectDelay * 2, 5 * 60 * 1000);
    });

    this.ws.on("error", (err) => {
      console.error("[vrchat] Pipeline websocket error:", err.message);
    });
  }

  async _reconnect() {
    try {
      // Re-verify/refresh session in case the cookie expired, then reconnect.
      await this.init();
      await this.connectRealtime();
    } catch (err) {
      console.error("[vrchat] Reconnect failed:", err.message);
      setTimeout(() => this._reconnect(), this._reconnectDelay);
    }
  }

  _handlePipelineMessage(msg) {
    if (!msg || !msg.type) return;

    // content is a JSON string that needs a second parse
    let content = null;
    if (typeof msg.content === "string") {
      try {
        content = JSON.parse(msg.content);
      } catch {
        content = null;
      }
    }

    switch (msg.type) {
      // Fired when a friend actually becomes active INSIDE the VRChat client
      // (desktop, PCVR, or standalone headset app). This is what we want.
      case "friend-online": {
        if (!content || !content.user) return;
        const user = content.user;
        const platform = user.platform || "";
        const isRealClient = this.allowedPlatforms.includes(platform);
        this.emit("friend-online", {
          id: content.userId || user.id,
          displayName: user.displayName,
          platform,
          isRealClient,
          worldId: user.worldId,
        });
        break;
      }
      // Fired when a friend is merely "active" on the website / companion app
      // WITHOUT being in the actual VRChat client. We deliberately ignore this.
      case "friend-active":
        break;
      case "friend-offline":
        if (content) {
          this.emit("friend-offline", { id: content.userId });
        }
        break;
      default:
        break;
    }
  }

  close() {
    if (this.ws) this.ws.close();
  }
}

module.exports = { VRChatClient, DEFAULT_ALLOWED_PLATFORMS };