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

const PACKAGES: Record<string, { label: string; price: string; emoji: string }> = {
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

const tickets = new Map<string, TicketState>(); // channelId → state

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** PayPal fee — USD: 3.49% + $0.49 */
function calcPaypalUsd(amount: number): string {
  return ((amount + 0.49) / (1 - 0.0349)).toFixed(2);
}

/** PayPal fee — EUR: 3.49% + €0.35 */
function calcPaypalEur(amount: number): string {
  return ((amount + 0.35) / (1 - 0.0349)).toFixed(2);
}

function buildPaymentEmbed(totalOverride?: string): EmbedBuilder {
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

function buildPackageButtons(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
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

function buildExtrasButtons(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("extras_skip")
      .setLabel("⏭️ No, continuar al pago")
      .setStyle(ButtonStyle.Secondary),
  );
}

// ─── Client ───────────────────────────────────────────────────────────────────

process.on("unhandledRejection", (err) =>
  logger.error({ err }, "Unhandled rejection"),
);
process.on("uncaughtException", (err) =>
  logger.error({ err }, "Uncaught exception"),
);

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

  // ── -paypal <cantidad> — solo el owner, muestra botones EUR/USD ───────────
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
        .setDescription(
          `Para recibir exactamente **${amount.toFixed(2)}**, ¿en qué moneda enviará el cliente?`,
        );
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
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

  // ── !log — fija el canal de logs (solo el owner) ──────────────────────────
  if (content === "!log") {
    if (message.author.id !== OWNER_ID) return;
    try {
      logChannelId = message.channelId;
      await message.reply(
        `✅ Canal de logs configurado. Todos los eventos de tickets se registrarán aquí.`,
      );
      logger.info({ channel: message.channelId }, "Log channel set");
    } catch (err) {
      logger.error({ err }, "Error configurando canal de logs");
    }
    return;
  }

  // ── !ticket — muestra el panel ────────────────────────────────────────────
  if (content === "!ticket") {
    try {
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("🛒 Realizar una Compra")
        .setDescription(
          "Antes de abrir un ticket, revisa <#1506477639810945095> para ver la información de los paquetes disponibles.\n\n" +
            "Cuando estés listo, haz clic en el botón de abajo para iniciar tu compra.",
        )
        .setThumbnail(message.guild.iconURL())
        .setImage(BANNER_IMAGE)
        .setFooter({ text: message.guild.name })
        .setTimestamp();

      const button = new ButtonBuilder()
        .setCustomId("open_ticket")
        .setLabel("Abrir Ticket")
        .setStyle(ButtonStyle.Primary)
        .setEmoji("🎫");

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(button);
      await message.channel.send({ embeds: [embed], components: [row] });
    } catch (err) {
      logger.error({ err }, "Error enviando panel !ticket");
    }
    return;
  }

  // ── Lógica dentro de canales de ticket ────────────────────────────────────
  const state = tickets.get(message.channelId);
  if (!state || message.author.bot) return;

  // !total <cantidad> — solo el owner, cuando hay extras pendientes
  if (
    content.toLowerCase().startsWith("!total ") &&
    state.status === "waiting_total"
  ) {
    if (message.author.id !== OWNER_ID) return;
    try {
      const totalStr = content.slice("!total ".length).trim();
      if (!totalStr) {
        await message.reply("❌ Uso: `!total 75` o `!total 75.50`");
        return;
      }

      state.total = totalStr;
      state.status = "waiting_payment";
      await message.delete().catch(() => {});

      const payEmbed = buildPaymentEmbed(totalStr);
      const sent = await message.channel.send({ embeds: [payEmbed] });
      state.lastBotMessageId = sent.id;
      logger.info({ channel: message.channelId, total: totalStr }, "Total set");

      await sendLog(
        new EmbedBuilder()
          .setColor(0xf0b90b)
          .setTitle("💰 Total Fijado")
          .addFields(
            { name: "👤 Usuario", value: `<@${state.userId}> (${state.username})`, inline: true },
            { name: "📦 Paquete", value: state.selectedPackage ?? "—", inline: true },
            { name: "➕ Extras", value: state.extras || "Ninguno", inline: true },
            { name: "💰 Total", value: totalStr, inline: true },
            { name: "🎫 Canal", value: `<#${message.channelId}>`, inline: true },
          )
          .setTimestamp(),
      );
    } catch (err) {
      logger.error({ err }, "Error procesando !total");
    }
    return;
  }

  // Captura de extras
  if (
    state.status === "selecting_extras" &&
    message.author.id === state.userId &&
    !content.startsWith("!") &&
    !content.startsWith("-")
  ) {
    try {
      state.extras = content;
      state.status = "waiting_total";

      if (state.lastBotMessageId) {
        await message.channel.messages
          .fetch(state.lastBotMessageId)
          .then((m) => m.delete())
          .catch(() => {});
        state.lastBotMessageId = null;
      }

      const confirmEmbed = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle("✅ Extra Registrado")
        .setDescription(
          "Tu solicitud fue registrada correctamente. El owner revisará los detalles y te confirmará el precio total.\n\n" +
            "**Una vez que el owner indique el total, se te mostrará el método de pago y deberás enviar el comprobante aquí.**",
        )
        .addFields(
          { name: "📦 Paquete", value: state.selectedPackage ?? "—", inline: true },
          { name: "➕ Extra solicitado", value: content, inline: true },
        )
        .setImage(BANNER_IMAGE)
        .setTimestamp();

      const sent = await message.channel.send({ embeds: [confirmEmbed] });
      state.lastBotMessageId = sent.id;

      await sendLog(
        new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle("➕ Extra Registrado")
          .addFields(
            { name: "👤 Usuario", value: `<@${state.userId}> (${state.username})`, inline: true },
            { name: "📦 Paquete", value: state.selectedPackage ?? "—", inline: true },
            { name: "➕ Extra", value: content, inline: true },
            { name: "🎫 Canal", value: `<#${message.channelId}>`, inline: true },
          )
          .setTimestamp(),
      );
    } catch (err) {
      logger.error({ err }, "Error guardando extras");
    }
    return;
  }

  // Comprobante de pago — solo imagen
  if (
    state.status === "waiting_payment" &&
    message.author.id === state.userId &&
    message.attachments.size > 0
  ) {
    try {
      const imageAttachment = [...message.attachments.values()].find((a) =>
        a.contentType?.startsWith("image/"),
      );
      if (!imageAttachment) return;

      state.status = "completed";

      // 1. Transcript HTML antes de borrar
      let transcriptFile: AttachmentBuilder | null = null;
      let transcriptUrl: string | null = null;
      try {
        transcriptFile = await createTranscript(message.channel as TextChannel, {
          limit: -1,
          returnType: ExportReturnType.Attachment,
          filename: `transcript-${state.username}-${Date.now()}.html`,
          poweredBy: false,
        });
      } catch (trErr) {
        logger.error({ trErr }, "Error generando transcript");
      }

      // 2. Descargar imagen antes del bulkDelete
      let imageFile: AttachmentBuilder | null = null;
      try {
        const res = await fetch(imageAttachment.url);
        const buf = Buffer.from(await res.arrayBuffer());
        imageFile = new AttachmentBuilder(buf, {
          name: imageAttachment.name ?? "comprobante.png",
        });
      } catch (fetchErr) {
        logger.error({ fetchErr }, "No se pudo descargar la imagen");
      }

      // 3. Borrar historial
      try {
        const allMessages = await message.channel.messages.fetch({ limit: 100 });
        await (message.channel as TextChannel).bulkDelete(allMessages, true);
      } catch { /* mensajes > 14 días */ }

      // 4. Transcript al canal de logs
      if (logChannelId && transcriptFile) {
        try {
          const logCh = client.channels.cache.get(logChannelId) as TextChannel | undefined;
          if (logCh) {
            const logEmbed = new EmbedBuilder()
              .setColor(0x57f287)
              .setTitle("✅ Comprobante Recibido — Transcript")
              .setDescription("Haz clic en el archivo HTML adjunto para ver la conversación completa.")
              .addFields(
                { name: "👤 Usuario", value: `<@${state.userId}> (${state.username})`, inline: true },
                { name: "📦 Paquete", value: state.selectedPackage ?? "—", inline: true },
                { name: "➕ Extras", value: state.extras || "Ninguno", inline: true },
                { name: "💰 Total", value: state.total ?? "—", inline: true },
              )
              .setThumbnail(message.author.displayAvatarURL())
              .setTimestamp();

            const logMsg = await logCh.send({ embeds: [logEmbed], files: [transcriptFile] });
            transcriptUrl = logMsg.attachments.first()?.url ?? null;
          }
        } catch (logErr) {
          logger.error({ logErr }, "Error enviando transcript al log");
        }
      }

      // 5. Resumen final en el ticket
      const closeRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("close_ticket")
          .setLabel("Cerrar Ticket")
          .setStyle(ButtonStyle.Danger)
          .setEmoji("🔒"),
      );

      const summaryDesc =
        `${message.author} ha enviado su comprobante.\n` +
        "Un miembro del staff verificará el pago y procesará el pedido. ¡Gracias!" +
        (transcriptUrl ? `\n\n📋 [Ver transcript completo](${transcriptUrl})` : "");

      const summaryEmbed = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle("✅ Pago Confirmado — Resumen del Pedido")
        .setDescription(summaryDesc)
        .addFields(
          { name: "📦 Paquete", value: state.selectedPackage ?? "—", inline: true },
          { name: "➕ Extras", value: state.extras && state.extras !== "" ? state.extras : "Ninguno", inline: true },
          { name: "💰 Total", value: state.total ?? state.selectedPackage?.match(/\$[\d+]+/)?.[0] ?? "—", inline: true },
        )
        .setThumbnail(message.author.displayAvatarURL())
        .setFooter({ text: `Usuario: ${message.author.tag} | ID: ${message.author.id}` })
        .setTimestamp();

      await message.channel.send({ embeds: [summaryEmbed], components: [closeRow] });

      if (imageFile) {
        await message.channel.send({
          content: `📸 **Comprobante de ${message.author.username}:**`,
          files: [imageFile],
        });
      }

      logger.info({ user: message.author.tag, channel: message.channelId }, "Payment proof received");
    } catch (err) {
      logger.error({ err }, "Error procesando comprobante");
    }
  }
});

// ─── Interactions ─────────────────────────────────────────────────────────────

client.on(Events.InteractionCreate, async (interaction) => {
  // ── Botones PayPal EUR/USD ────────────────────────────────────────────────
  if (
    interaction.isButton() &&
    (interaction.customId.startsWith("paypal_usd_") ||
      interaction.customId.startsWith("paypal_eur_"))
  ) {
    try {
      const isEur = interaction.customId.startsWith("paypal_eur_");
      const amtStr = interaction.customId
        .replace(isEur ? "paypal_eur_" : "paypal_usd_", "")
        .replace("d", ".");
      const amount = parseFloat(amtStr);
      if (isNaN(amount)) {
        await interaction.reply({ content: "❌ Error en el cálculo.", ephemeral: true });
        return;
      }

      const toSend = isEur ? calcPaypalEur(amount) : calcPaypalUsd(amount);
      const currency = isEur ? "EUR €" : "USD $";
      const symbol = isEur ? "€" : "$";

      const embed = new EmbedBuilder()
        .setColor(0x003087)
        .setTitle("<:PayPal:1473846201014292584> Calculadora PayPal")
        .setDescription(
          `Para que se reciban exactamente **${symbol}${amount.toFixed(2)} ${currency}**,\n` +
            `el cliente debe enviar: **${symbol}${toSend} ${currency}**\n\n` +
            `*(incluye comisión de PayPal: 3.49% + ${isEur ? "€0.35" : "$0.49"})*`,
        );

      await interaction.update({ embeds: [embed], components: [] });
    } catch (err) {
      logger.error({ err }, "Error en botón PayPal");
    }
    return;
  }

  // ── Abrir Ticket ──────────────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === "open_ticket") {
    if (!interaction.guild) return;
    try {
      await interaction.deferReply({ ephemeral: true });

      const user = interaction.user;

      const permissionOverwrites = [
        { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        {
          id: user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
          ],
        },
      ];

      for (const [, role] of interaction.guild.roles.cache) {
        if (
          role.id !== interaction.guild.roles.everyone.id &&
          role.permissions.has(PermissionFlagsBits.Administrator)
        ) {
          permissionOverwrites.push({
            id: role.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
              PermissionFlagsBits.ManageMessages,
            ],
          });
        }
      }

      const safeName = user.username.toLowerCase().replace(/[^a-z0-9-_]/g, "").slice(0, 20);
      const ticketChannel = await interaction.guild.channels.create({
        name: `ticket-${safeName || user.id}`,
        type: ChannelType.GuildText,
        permissionOverwrites,
      });

      tickets.set(ticketChannel.id, {
        userId: user.id,
        username: user.username,
        selectedPackage: null,
        extras: null,
        total: null,
        status: "selecting_package",
        lastBotMessageId: null,
      });

      const welcomeEmbed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("🎫 Ticket Abierto")
        .setDescription(`Bienvenido/a ${user} 👋\n\nPara continuar, selecciona el **paquete** que deseas adquirir:`)
        .addFields(
          { name: "⭐ Esencial", value: "`$30`", inline: true },
          { name: "💎 Pro Advanced", value: "`$65`", inline: true },
          { name: "👑 Premium", value: "`$140+`", inline: true },
        )
        .setThumbnail(user.displayAvatarURL())
        .setImage(BANNER_IMAGE)
        .setTimestamp();

      const sent = await ticketChannel.send({ embeds: [welcomeEmbed], components: [buildPackageButtons()] });
      tickets.get(ticketChannel.id)!.lastBotMessageId = sent.id;

      await interaction.editReply({ content: `✅ Tu ticket fue creado: ${ticketChannel}` });

      await sendLog(
        new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle("🎫 Ticket Abierto")
          .addFields(
            { name: "👤 Usuario", value: `<@${user.id}> (${user.username})`, inline: true },
            { name: "🎫 Canal", value: `<#${ticketChannel.id}>`, inline: true },
          )
          .setTimestamp(),
      );

      logger.info({ user: user.tag, channel: ticketChannel.name }, "Ticket created");
    } catch (err) {
      logger.error({ err }, "Error creando ticket");
      try {
        const msg = { content: "❌ Error al crear el ticket. Asegúrate de que el bot tenga permisos de Administrador." };
        if (interaction.replied || interaction.deferred) await interaction.editReply(msg);
        else await interaction.reply({ ...msg, ephemeral: true });
      } catch { /* ignore */ }
    }
    return;
  }

  // ── Selección de paquete ──────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith("pkg_")) {
    const state = tickets.get(interaction.channelId ?? "");
    if (!state || state.status !== "selecting_package") {
      await interaction.reply({ content: "❌ Esta acción no está disponible.", ephemeral: true });
      return;
    }
    if (interaction.user.id !== state.userId) {
      await interaction.reply({ content: "❌ Solo el creador del ticket puede responder.", ephemeral: true });
      return;
    }

    try {
      const pkgKey = interaction.customId.replace("pkg_", "") as keyof typeof PACKAGES;
      const pkg = PACKAGES[pkgKey];
      state.selectedPackage = `${pkg.emoji} ${pkg.label} (${pkg.price})`;
      state.status = "selecting_extras";

      await interaction.deferUpdate();

      if (state.lastBotMessageId) {
        await interaction.channel?.messages.fetch(state.lastBotMessageId)
          .then((m) => m.delete()).catch(() => {});
      }

      const extrasEmbed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("➕ ¿Deseas agregar algo extra?")
        .setDescription(
          `Paquete seleccionado: **${state.selectedPackage}**\n\n` +
            "Si quieres agregar algo extra a tu pedido, **escríbelo aquí.**\n" +
            "Si no deseas nada extra, haz clic en el botón de abajo.\n\n" +
            "💡 *Ejemplo: \"Agregar un logo personalizado\", \"Banner animado\", etc.*",
        )
        .setImage(BANNER_IMAGE)
        .setTimestamp();

      const sent = await (interaction.channel as TextChannel).send({
        embeds: [extrasEmbed],
        components: [buildExtrasButtons()],
      });
      state.lastBotMessageId = sent?.id ?? null;

      await sendLog(
        new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle("📦 Paquete Seleccionado")
          .addFields(
            { name: "👤 Usuario", value: `<@${state.userId}> (${state.username})`, inline: true },
            { name: "📦 Paquete", value: state.selectedPackage, inline: true },
            { name: "🎫 Canal", value: `<#${interaction.channelId}>`, inline: true },
          )
          .setTimestamp(),
      );
    } catch (err) {
      logger.error({ err }, "Error procesando selección de paquete");
    }
    return;
  }

  // ── Saltar extras ─────────────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === "extras_skip") {
    const state = tickets.get(interaction.channelId ?? "");
    if (!state || state.status !== "selecting_extras") {
      await interaction.reply({ content: "❌ Esta acción no está disponible.", ephemeral: true });
      return;
    }
    if (interaction.user.id !== state.userId) {
      await interaction.reply({ content: "❌ Solo el creador del ticket puede responder.", ephemeral: true });
      return;
    }

    try {
      state.extras = "";
      state.status = "waiting_payment";
      await interaction.deferUpdate();

      if (state.lastBotMessageId) {
        await interaction.channel?.messages.fetch(state.lastBotMessageId)
          .then((m) => m.delete()).catch(() => {});
        state.lastBotMessageId = null;
      }

      const payEmbed = buildPaymentEmbed();
      const sent = await (interaction.channel as TextChannel).send({ embeds: [payEmbed] });
      state.lastBotMessageId = sent?.id ?? null;
    } catch (err) {
      logger.error({ err }, "Error saltando extras");
    }
    return;
  }

  // ── Cerrar Ticket ─────────────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === "close_ticket") {
    if (!interaction.channel || !interaction.guild) return;
    try {
      await interaction.reply({ content: "🔒 Cerrando el ticket en 5 segundos…" });
      setTimeout(() => {
        interaction.channel?.delete("Ticket cerrado").catch((err: unknown) =>
          logger.error({ err }, "Error eliminando canal de ticket"),
        );
      }, 5000);
    } catch (err) {
      logger.error({ err }, "Error cerrando ticket");
    }
  }
});

// ─── Login ────────────────────────────────────────────────────────────────────

logger.info("Logging in to Discord…");
await client.login(token);