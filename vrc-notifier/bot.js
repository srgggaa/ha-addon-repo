require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
} = require("discord.js");
const { VRChatClient } = require("./vrchat");
const store = require("./store");

const {
  DISCORD_TOKEN,
  DISCORD_CLIENT_ID,
  OWNER_DISCORD_ID,
  VRCHAT_USERNAME,
  VRCHAT_PASSWORD,
} = process.env;

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID || !OWNER_DISCORD_ID || !VRCHAT_USERNAME || !VRCHAT_PASSWORD) {
  console.error("Missing required .env values. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

let data = store.load();
let friendsCache = []; // full VRChat friends list: [{id, displayName}]
let vrc = null; // active VRChatClient instance, set once startVRChat() finishes

// How often to silently refresh the full friends list in the background.
const FRIEND_REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

// ---------- Slash command definitions ----------
const commands = [
  new SlashCommandBuilder()
    .setName("vrc-friends")
    .setDescription("List all your VRChat friends (so you can find their name to watch).")
    .addStringOption((opt) =>
      opt.setName("search").setDescription("Filter by name (optional)").setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("vrc-watch-add")
    .setDescription("Get notified when this friend comes online in VRChat.")
    .addStringOption((opt) =>
      opt.setName("name").setDescription("Exact VRChat display name of the friend").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("vrc-watch-remove")
    .setDescription("Stop watching a friend.")
    .addStringOption((opt) =>
      opt.setName("name").setDescription("Exact VRChat display name of the friend").setRequired(true)
    ),
  new SlashCommandBuilder().setName("vrc-watch-list").setDescription("Show the friends currently being watched."),
  new SlashCommandBuilder()
    .setName("vrc-dm-online")
    .setDescription("DM you now, once per friend, for every VRChat friend who is online right now."),
  new SlashCommandBuilder()
    .setName("vrc-set-message")
    .setDescription("Set the notification message. Use {friend} where the name should go.")
    .addStringOption((opt) =>
      opt.setName("template").setDescription("e.g. 🟢 {friend} is online in VRChat!").setRequired(true)
    ),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body: commands });
  console.log("[discord] Slash commands registered.");
}

// ---------- Discord client ----------
const discord = new Client({ intents: [GatewayIntentBits.Guilds] });

function findFriendByName(name) {
  const lower = name.toLowerCase();
  return (
    friendsCache.find((f) => f.displayName.toLowerCase() === lower) ||
    friendsCache.find((f) => f.displayName.toLowerCase().includes(lower))
  );
}

discord.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // Restrict all commands to the bot owner (this is a personal-use bot).
  if (interaction.user.id !== OWNER_DISCORD_ID) {
    return interaction.reply({ content: "This bot is private and only configurable by its owner.", ephemeral: true });
  }

  try {
    if (interaction.commandName === "vrc-friends") {
      const search = interaction.options.getString("search");
      let list = friendsCache;
      if (search) {
        const lower = search.toLowerCase();
        list = list.filter((f) => f.displayName.toLowerCase().includes(lower));
      }
      list = list.slice(0, 40);
      if (list.length === 0) {
        return interaction.reply({ content: "No matching friends found.", ephemeral: true });
      }
      const embed = new EmbedBuilder()
        .setTitle("VRChat Friends")
        .setDescription(list.map((f) => `• ${f.displayName}`).join("\n"))
        .setFooter({ text: list.length === 40 ? "Showing first 40 results, narrow your search for more." : `${list.length} result(s)` });
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (interaction.commandName === "vrc-watch-add") {
      const name = interaction.options.getString("name");
      const friend = findFriendByName(name);
      if (!friend) {
        return interaction.reply({ content: `Couldn't find a VRChat friend matching "${name}". Try /vrc-friends to search.`, ephemeral: true });
      }
      data.watchedFriends[friend.id] = { displayName: friend.displayName };
      store.save(data);
      return interaction.reply({ content: `👀 Now watching **${friend.displayName}**.`, ephemeral: true });
    }

    if (interaction.commandName === "vrc-watch-remove") {
      const name = interaction.options.getString("name");
      const entry = Object.entries(data.watchedFriends).find(
        ([, v]) => v.displayName.toLowerCase() === name.toLowerCase()
      );
      if (!entry) {
        return interaction.reply({ content: `"${name}" isn't currently being watched.`, ephemeral: true });
      }
      delete data.watchedFriends[entry[0]];
      store.save(data);
      return interaction.reply({ content: `Stopped watching **${entry[1].displayName}**.`, ephemeral: true });
    }

    if (interaction.commandName === "vrc-watch-list") {
      const entries = Object.values(data.watchedFriends);
      if (entries.length === 0) {
        return interaction.reply({ content: "You're not watching anyone yet. Use /vrc-watch-add.", ephemeral: true });
      }
      return interaction.reply({
        content: `**Currently watching:**\n${entries.map((e) => `• ${e.displayName}`).join("\n")}`,
        ephemeral: true,
      });
    }

    if (interaction.commandName === "vrc-dm-online") {
      if (!vrc) {
        return interaction.reply({ content: "VRChat isn't connected yet, try again in a moment.", ephemeral: true });
      }
      await interaction.deferReply({ ephemeral: true });

      let online;
      try {
        online = await vrc.getOnlineFriends();
      } catch (err) {
        console.error("[vrchat] getOnlineFriends failed:", err.message);
        return interaction.editReply({ content: "Couldn't fetch your online friends from VRChat, try again shortly." });
      }

      if (online.length === 0) {
        return interaction.editReply({ content: "No friends are online right now." });
      }

      // Small delay between DMs so we don't hammer Discord's rate limit for
      // a large friends list all at once.
      let sent = 0;
      for (const friend of online) {
        const message = data.messageTemplate.replaceAll("{friend}", friend.displayName);
        await notifyOwner(message);
        sent += 1;
        await new Promise((r) => setTimeout(r, 400));
      }

      return interaction.editReply({ content: `Sent ${sent} DM(s) for friends who are currently online.` });
    }

    if (interaction.commandName === "vrc-set-message") {
      const template = interaction.options.getString("template");
      if (!template.includes("{friend}")) {
        return interaction.reply({ content: 'Your template must include "{friend}" so I know where to put the name.', ephemeral: true });
      }
      data.messageTemplate = template;
      store.save(data);
      return interaction.reply({ content: `Message template updated:\n> ${template.replace("{friend}", "ExampleFriend")}`, ephemeral: true });
    }
  } catch (err) {
    console.error("[discord] command error:", err);
    if (interaction.deferred || interaction.replied) {
      interaction.followUp({ content: "Something went wrong.", ephemeral: true }).catch(() => {});
    } else {
      interaction.reply({ content: "Something went wrong.", ephemeral: true }).catch(() => {});
    }
  }
});

async function notifyOwner(text) {
  try {
    const user = await discord.users.fetch(OWNER_DISCORD_ID);
    await user.send(text);
  } catch (err) {
    console.error("[discord] Failed to DM owner:", err.message);
  }
}

// ---------- VRChat wiring ----------
async function startVRChat() {
  vrc = new VRChatClient({ username: VRCHAT_USERNAME, password: VRCHAT_PASSWORD });
  await vrc.init();

  friendsCache = await vrc.getFriendsList();
  console.log(`[vrchat] Loaded ${friendsCache.length} friends.`);

  // Keep the cached friends list (used by /vrc-friends and /vrc-watch-add)
  // fresh in the background, since it's otherwise only fetched once at boot.
  setInterval(async () => {
    try {
      friendsCache = await vrc.getFriendsList();
      console.log(`[vrchat] Refreshed friends list (${friendsCache.length} friends).`);
    } catch (err) {
      console.error("[vrchat] Background friends list refresh failed:", err.message);
    }
  }, FRIEND_REFRESH_INTERVAL_MS);

  vrc.on("friend-online", (info) => {
    const watched = data.watchedFriends[info.id];
    if (!watched) return; // not someone we're tracking

    const message = data.messageTemplate.replaceAll("{friend}", info.displayName);
    console.log(`[notify] ${info.displayName} came online in VRChat (platform=${info.platform}).`);
    notifyOwner(message);
  });

  await vrc.connectRealtime();
  return vrc;
}

// ---------- Boot ----------
(async () => {
  await registerCommands();
  await discord.login(DISCORD_TOKEN);
  console.log("[discord] Bot logged in.");
  await startVRChat();
})().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
