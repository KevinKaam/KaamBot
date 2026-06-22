import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  TextChannel,
} from "discord.js";
import { createTranscript, ExportReturnType } from "discord-html-transcripts";
import { logger } from "./lib/logger.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) throw new Error("DISCORD_BOT_TOKEN is required");

const BANNER_IMAGE =
  "https://media.discordapp.net/attachments/1505743553056477415/1518414475370172536/wmremove-transformed_2.jpeg?ex=6a39d52d&is=6a3883ad&hm=03041edd9e199290f8e70e248ed9156a87e2a2206923a98b13cae476452503c8&=&format=webp&width=683&height=381";

const OWNER_ID = "1254918801569349676";

// CORREGIDO: Eliminada la sintaxis de TypeScript (": Record<...>")
const PACKAGES = {
  esencial: { label: "Esencial", price: "$30", emoji: "⭐" },
  pro: { label: "Pro Advanced", price: "$65", emoji: "💎" },
  premium: { label: "Premium", price: "$140+", emoji: "👑" },
};

// ─── Log channel ──────────────────────────────────────────────────────────────

let logChannelId: string | null = null;

async function sendLog(embed: EmbedBuilder): Promise<void> {
  if (!logChannelId) return;
  try {
    const ch = client.channels.cache.get(logChannelId) as TextChannel | undefined;
    if (ch) await ch.send({ embeds: [embed] });
  } catch (err) {
    logger.error({ err }, "Error enviando log");
  }
}

// ─── Ticket State ─────────────────────────────────────────────────────────────

type TicketStatus =
  | "selecting_package"
  | "selecting_extras"
  | "waiting_total"
  | "waiting_payment"
  | "completed";

interface TicketState {
  userId: string;
  username: string;
  selectedPackage: string | null;
  extras: string | null;
  total: string | null;
  status: TicketStatus;
  lastBotMessageId: string | null;
}

const tickets = new Map(); // channelId → state

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** PayPal fee — USD: 3.49% + $0.49 */
function calcPaypalUsd(amount) {
  return ((amount + 0.49) / (1 - 0.0349)).toFixed(2);
}

/** PayPal fee — EUR: 3.49% + €0.35 */
function calcPaypalEur(amount) {
  return ((amount + 0.35) / (1 - 0.0349)).toFixed(2);
}

function buildPaymentEmbed(totalOverride) {
  const totalLine = totalOverride
    ? `💰 **Total a pagar: ${totalOverride}**\n\n`
    : "";

  return new EmbedBuilder()
    .setColor(0xf0b90b)
    .setTitle("💳 Métodos de Pago")
    .setDescription(
      totalLine +
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "<:Binance:1473846747716390993> **BINANCE**\n" +
      "👤 Alias: `iKevs`\n" +
      "🆔 ID: `894504697`\n" +
      "📧 Correo: `kevinsito282008@hotmail.com`\n\n" +
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "<:PayPal:1473846201014292584> **PAYPAL**\n" +
      "👤 Kevin Algarin\n" +
      "📧 `keag29@hotmail.com`\n\n" +
      "⚠️ **IMPORTANTE**\n" +
      "Si utilizas PayPal debes cubrir cualquier comisión para que el importe recibido coincida con el precio del paquete.\n\n" +
      "💡 **Calculadora PayPal:** `-paypal <cantidad>`\n" +
      "Ejemplo: `-paypal 65`\n\n" +
      "━━━━━━━━━━━━━━━━━━\n\n" +
      "📸 **Envía la captura del comprobante de pago en este canal para continuar.**"
    )
    .setImage(BANNER_IMAGE)
    .setTimestamp();
}

function buildPackageButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("pkg_esencial")
      .setLabel("⭐ Esencial ($30)")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("pkg_pro")
      .setLabel("💎 Pro Advanced ($65)")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("pkg_premium")
      .setLabel("👑 Premium ($140+)")
      .setStyle(ButtonStyle.Success),
  );
}

function buildExtrasButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("extras_skip")
      .setLabel("⏭️ No, continuar al pago")
      .setStyle(ButtonStyle.Secondary),
  );
}

// ─── Client ───────────────────────────────────────────────────────────────────

process.on("unhandledRejection", (err) => logger.error({ err }, "Unhandled rejection"));
process.on("uncaughtException", (err) => logger.error({ err }, "Uncaught exception"));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, (rc) => {
  logger.info({ tag: rc.user.tag, guilds: rc.guilds.cache.size }, "Bot ready");
});

// ─── Messages ─────────────────────────────────────────────────────────────────

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;
  const content = message.content.trim();

  if (content.toLowerCase().startsWith("-paypal ")) {
    if (message.author.id !== OWNER_ID) return;
    try {
      const raw = content.slice("-paypal ".length).trim();
      const amount = parseFloat(raw);
      if (isNaN(amount) || amount <= 0) {
        await message.reply("❌ Uso correcto: `-paypal 65`");
        return;
      }
      const amtStr = raw.replace(".", "d");
      const embed = new EmbedBuilder()
        .setColor(0x003087)
        .setTitle("<:PayPal:1473846201014292584> Calculadora PayPal")
        .setDescription(`Para recibir exactamente **${amount.toFixed(2)}**, ¿en qué moneda enviará el cliente?`);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`paypal_usd_${amtStr}`)
          .setLabel("💵 USD (Dólares)")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`paypal_eur_${amtStr}`)
          .setLabel("💶 Euro")
          .setStyle(ButtonStyle.Secondary),
      );
      await message.reply({ embeds: [embed], components: [row] });
    } catch (err) {
      logger.error({ err }, "Error en calculadora PayPal");
    }
    return;
  }

  if (content === "!log") {
    if (message.author.id !== OWNER_ID) return;
    logChannelId = message.channelId;
    await message.reply(`✅ Canal de logs configurado.`);
    return;
  }

  if (content === "!ticket") {
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle("🛒 Realizar una Compra")
      .setDescription("Cuando estés listo, haz clic en el botón para iniciar.")
      .setImage(BANNER_IMAGE)
      .setTimestamp();
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("open_ticket").setLabel("Abrir Ticket").setStyle(ButtonStyle.Primary).setEmoji("🎫")
    );
    await message.channel.send({ embeds: [embed], components: [row] });
    return;
  }

  const state = tickets.get(message.channelId);
  if (!state || message.author.bot) return;

  if (content.toLowerCase().startsWith("!total ") && state.status === "waiting_total") {
    if (message.author.id !== OWNER_ID) return;
    const totalStr = content.slice("!total ".length).trim();
    state.total = totalStr;
    state.status = "waiting_payment";
    const payEmbed = buildPaymentEmbed(totalStr);
    const sent = await message.channel.send({ embeds: [payEmbed] });
    state.lastBotMessageId = sent.id;
    return;
  }

  if (state.status === "selecting_extras" && message.author.id === state.userId && !content.startsWith("!") && !content.startsWith("-")) {
    state.extras = content;
    state.status = "waiting_total";
    const confirmEmbed = new EmbedBuilder().setColor(0x57f287).setTitle("✅ Extra Registrado").setDescription("El owner confirmará el precio.");
    const sent = await message.channel.send({ embeds: [confirmEmbed] });
    state.lastBotMessageId = sent.id;
    return;
  }

  if (state.status === "waiting_payment" && message.author.id === state.userId && message.attachments.size > 0) {
    state.status = "completed";
    await message.channel.send({ content: "✅ Pago recibido, un staff te atenderá." });
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isButton() && interaction.customId === "open_ticket") {
    const ticketChannel = await interaction.guild.channels.create({
      name: `ticket-${interaction.user.username.slice(0, 10)}`,
      type: ChannelType.GuildText,
    });
    tickets.set(ticketChannel.id, { userId: interaction.user.id, status: "selecting_package" });
    const welcome = new EmbedBuilder().setTitle("🎫 Ticket Abierto").setDescription("Selecciona un paquete:");
    await ticketChannel.send({ embeds: [welcome], components: [buildPackageButtons()] });
    await interaction.reply({ content: `✅ Ticket creado: ${ticketChannel}`, ephemeral: true });
  }

  if (interaction.isButton() && interaction.customId.startsWith("pkg_")) {
    const state = tickets.get(interaction.channelId);
    const pkgKey = interaction.customId.replace("pkg_", "");
    state.selectedPackage = PACKAGES[pkgKey].label;
    state.status = "selecting_extras";
    await interaction.update({ content: "📦 Paquete seleccionado. Escribe aquí si deseas algo extra (o presiona el botón para saltar).", components: [buildExtrasButtons()] });
  }

  if (interaction.isButton() && interaction.customId === "extras_skip") {
    const state = tickets.get(interaction.channelId);
    state.status = "waiting_payment";
    await interaction.update({ content: "💳 **Envía tu comprobante de pago:**", components: [] });
  }
});

await client.login(token);