const fs = require("fs");
const path = require("path");

const DATA_FILE = path.join(__dirname, "data.json");

const DEFAULT_DATA = {
  // vrchatUserId -> { displayName }
  watchedFriends: {},
  // {friend} gets replaced with the friend's display name
  messageTemplate: "🟢 **{friend}** just came online in VRChat!",
};

function load() {
  if (!fs.existsSync(DATA_FILE)) {
    save(DEFAULT_DATA);
    return { ...DEFAULT_DATA };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    return { ...DEFAULT_DATA, ...raw };
  } catch {
    return { ...DEFAULT_DATA };
  }
}

function save(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
}

module.exports = { load, save, DATA_FILE };
