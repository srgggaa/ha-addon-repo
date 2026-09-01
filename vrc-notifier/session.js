const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { wrapper } = require("axios-cookiejar-support");
const { CookieJar } = require("tough-cookie");
const readline = require("readline");

const SESSION_FILE = path.join(__dirname, "session.json");
const USER_AGENT = "VRCFriendNotifierBot/1.0 (contact: set-your-email-here)";

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => {
    rl.close();
    resolve(answer.trim());
  }));
}

function buildClient(jar) {
  const client = wrapper(axios.create({
    baseURL: "https://api.vrchat.cloud/api/1",
    jar,
    withCredentials: true,
    headers: { "User-Agent": USER_AGENT },
  }));
  return client;
}

async function loadSavedJar() {
  if (!fs.existsSync(SESSION_FILE)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
    return CookieJar.fromJSON(JSON.stringify(raw));
  } catch {
    return null;
  }
}

function saveJar(jar) {
  fs.writeFileSync(SESSION_FILE, JSON.stringify(jar.toJSON()), "utf8");
}

// Verifies the current cookie jar is still an authenticated session.
async function verify(client) {
  try {
    const res = await client.get("/auth/user");
    if (res.data && res.data.id) return res.data;
    return null;
  } catch {
    return null;
  }
}

async function login({ username, password }) {
  let jar = (await loadSavedJar()) || new CookieJar();
  let client = buildClient(jar);

  let me = await verify(client);
  if (me) {
    console.log(`[vrchat] Reusing saved session for ${me.displayName}`);
    return { client, jar, user: me };
  }

  console.log("[vrchat] No valid saved session, logging in fresh...");
  jar = new CookieJar();
  client = buildClient(jar);

  // --- DEBUG: sanity-check what we're actually about to send (no plaintext password logged) ---
  console.log(`[vrchat][debug] username length=${username ? username.length : 0}, password length=${password ? password.length : 0}`);
  console.log(`[vrchat][debug] username value (quoted)=${JSON.stringify(username)}`);
  console.log(`[vrchat][debug] password has leading/trailing whitespace=${password !== password.trim()}`);
  // ---------------------------------------------------------------------------------------------

  const basicAuth = Buffer.from(`${encodeURIComponent(username)}:${encodeURIComponent(password)}`).toString("base64");
  client.defaults.headers.common["Authorization"] = `Basic ${basicAuth}`;
  let res;
  try {
    res = await client.get("/auth/user");
    // --- DEBUG: show what VRChat actually returned on success ---
    console.log("[vrchat][debug] /auth/user response status:", res.status);
    console.log("[vrchat][debug] /auth/user response data:", JSON.stringify(res.data));
    console.log("[vrchat][debug] /auth/user raw set-cookie header:", JSON.stringify(res.headers["set-cookie"]));
    // --------------------------------------------------------------
  } catch (err) {
    // --- DEBUG: dump everything we can about the failure ---
    if (err.response) {
      console.error("[vrchat][debug] login failed - status:", err.response.status);
      console.error("[vrchat][debug] login failed - headers:", JSON.stringify(err.response.headers));
      console.error("[vrchat][debug] login failed - body:", JSON.stringify(err.response.data));
    } else {
      console.error("[vrchat][debug] login failed - no response object, raw error:", err.message);
    }
    // ---------------------------------------------------------
    if (err.response && err.response.status === 401) {
      throw new Error("VRChat login failed: invalid username/password.");
    }
    throw err;
  }

  // Handle 2FA if VRChat asks for it
  const requiresAuth = res.data && res.data.requiresTwoFactorAuth;
  if (requiresAuth) {
    const methods = res.data.requiresTwoFactorAuth;
    const isEmail = methods.includes("emailOtp");
    const code = await ask(
      `[vrchat] 2FA required (${methods.join(", ")}). Enter the ${isEmail ? "email" : "authenticator app"} code: `
    );
    const endpoint = isEmail ? "/auth/twofactorauth/emailotp/verify" : "/auth/twofactorauth/totp/verify";
    const verifyRes = await client.post(endpoint, { code });
    console.log("[vrchat][debug] 2FA verify raw set-cookie header:", JSON.stringify(verifyRes.headers["set-cookie"]));
    if (!verifyRes.data || !verifyRes.data.verified) {
      throw new Error("VRChat 2FA verification failed.");
    }
  }

  me = await verify(client);
  if (!me) throw new Error("VRChat login did not result in a valid session.");

  console.log("[vrchat][debug] full jar after login:", JSON.stringify(jar.toJSON()));
  saveJar(jar);
  console.log(`[vrchat] Logged in fresh as ${me.displayName}`);
  return { client, jar, user: me };
}

module.exports = { login, saveJar, USER_AGENT };