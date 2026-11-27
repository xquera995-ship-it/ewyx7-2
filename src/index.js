require('dotenv').config();
const {
  Client, GatewayIntentBits, Partials, Collection, REST, Routes,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ChannelSelectMenuBuilder, RoleSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, PermissionFlagsBits,
  ChannelType, AuditLogEvent, GuildVerificationLevel
} = require('discord.js');
const {
  GuildConfig, UserStats, Warning, Ticket, Giveaway, Drop, Application,
  Reminder, Suggestion, Birthday, Tkm, Poll, ReactionRole, initDatabase
} = require('./models');
const { isFiltered } = require('./lib/filter');
const { configFor, log, can, admin, parseTime, addXp } = require('./lib/helpers');

if (!process.env.DISCORD_TOKEN || !process.env.CLIENT_ID) {
  console.error('DISCORD_TOKEN ve CLIENT_ID Railway Variables bölümünde zorunludur.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildModeration, GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildInvites, GatewayIntentBits.GuildMessageReactions
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember, Partials.Reaction]
});
client.prefix = process.env.PREFIX || '!';
const joinBuckets = new Map();
const botJoinBuckets = new Map();
const spamBuckets = new Map();
const voiceTimers = new Map();
const giveawayTimers = new Map();
const dropTimers = new Map();

function isStaff(member) {
  return member.permissions.has(PermissionFlagsBits.Administrator) ||
    member.permissions.has(PermissionFlagsBits.ManageMessages) ||
    member.permissions.has(PermissionFlagsBits.ManageChannels);
}
async function isTicketStaff(member) {
  if (isStaff(member)) return true;
  const cfg = await configFor(member.guild.id);
  return (cfg.ticketSupportRoleIds || []).some(roleId => member.roles.cache.has(roleId));
}
function mentionUser(message, args) {
  return message.mentions.users.first() || (args[0] ? client.users.fetch(args[0]).catch(() => null) : null);
}
function durationText(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600),
    m = Math.floor(sec % 3600 / 60), s = sec % 60;
  return [d && `${d}g`, h && `${h}s`, m && `${m}d`, s && `${s}sn`].filter(Boolean).join(' ');
}
async function requirePermission(message, permission, label) {
  if (!can(message.member, permission)) {
    await message.reply(`⛔ Bu komut için **${label}** izni gerekiyor.`);
    return false;
  }
  return true;
}
async function setupPanel(channel, userId) {
  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(`setup_select:${userId}`).setPlaceholder('Ayarlamak istediğin sistemi seç')
      .addOptions(
        { label: 'Log kanalı', value: 'log', description: 'Bütün kayıtların gönderileceği kanal' },
        { label: 'Hoş geldin kanalı', value: 'welcome' },
        { label: 'Ayrılma kanalı', value: 'leave' },
        { label: 'Otomatik rol', value: 'autorole' },
        { label: 'Karantina rolü', value: 'quarantine' },
        { label: 'Öneri kanalı', value: 'suggestion' },
        { label: 'Duyuru kanalı', value: 'announcement' },
        { label: 'Sohbet kanalı', value: 'chat' },
        { label: 'Başvuru kanalı', value: 'application' },
        { label: 'Ticket panel kanalı', value: 'ticketpanel' },
        { label: 'Başvuru kabul rolü', value: 'applicationRole' },
        { label: 'Ticket yetkili rolü ekle', value: 'ticketSupportRole' }
      )
  );
  const embed = new EmbedBuilder().setColor(0x7C3AED).setTitle('WYX | Kurulum Paneli')
    .setDescription('Aşağıdaki menüden ayarlamak istediğin sistemi seç. Ayarlar bu sunucuya özel olarak kaydedilir.');
  return channel.send({ embeds: [embed], components: [row] });
}
async function createTicketPanel(channel, guild) {
  const cfg = await configFor(guild.id);
  const cats = cfg.ticketCategories.length ? cfg.ticketCategories : ['Genel Destek'];
  const options = cats.slice(0,10).map((x,i) => ({ label: x.slice(0,100), value: String(i), description: `${x} kategorisinde destek talebi oluştur` }));
  const menu = new StringSelectMenuBuilder().setCustomId('ticket_create').setPlaceholder('Destek kategorisini seç').addOptions(options);
  const embed = new EmbedBuilder().setColor(0x7C3AED).setTitle('🎫 WYX Destek Merkezi')
    .setDescription('Destek almak için aşağıdaki menüden uygun kategoriyi seç. Her kullanıcının aynı anda yalnızca bir açık ticketi olabilir.');
  return channel.send({ embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)] });
}
async function finishGiveaway(giveawayId) {
  const g = await Giveaway.findById(giveawayId);
  if (!g || g.ended) return;
  g.ended = true;
  await g.save();
  const channel = await client.channels.fetch(g.channelId).catch(() => null);
  if (!channel?.isTextBased()) return;
  const winners = [...g.entrants].sort(() => Math.random() - 0.5).slice(0, Math.min(g.winnersCount, g.entrants.length));
  const msg = await channel.messages.fetch(g.messageId).catch(() => null);
  if (msg) await msg.edit({ components: [] }).catch(() => null);
  await channel.send(winners.length
    ? `🎉 **${g.prize}** çekilişinin kazananları: ${winners.map(id => `<@${id}>`).join(', ')}`
    : `Çekiliş sona erdi ancak katılımcı olmadı. Ödül: **${g.prize}**`);
}
async function finishDrop(dropId, winnerId = null) {
  const d = await Drop.findById(dropId);
  if (!d || d.ended) return;
  d.ended = true; d.winnerId = winnerId;
  await d.save();
  const channel = await client.channels.fetch(d.channelId).catch(() => null);
  const msg = channel?.isTextBased() ? await channel.messages.fetch(d.messageId).catch(() => null) : null;
  if (msg) await msg.edit({ components: [] }).catch(() => null);
  if (winnerId && channel?.isTextBased()) await channel.send(`🎁 <@${winnerId}> **${d.prize}** drop ödülünü kazandı!`);
}
async function sendApplicationDM(app) {
  const ownerId = process.env.OWNER_ID;
  if (!ownerId) return false;
  const owner = await client.users.fetch(ownerId).catch(() => null);
  if (!owner) return false;
  const user = await client.users.fetch(app.userId).catch(() => null);
  const embed = new EmbedBuilder().setColor(0x7C3AED).setTitle('Yeni Yetkili Başvurusu')
    .setDescription(`Başvuran: ${user ? `${user.tag} (${user.id})` : app.userId}`)
    .addFields(app.answers.map((a,i) => ({ name: `Soru ${i+1}`, value: a.slice(0,1024) || 'Cevap yok' })))
    .setTimestamp();
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`app_accept:${app._id}`).setLabel('Kabul Et').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`app_reject:${app._id}`).setLabel('Reddet').setStyle(ButtonStyle.Danger)
  );
  await owner.send({ embeds: [embed], components: [row] });
  return true;
}

client.once('ready', async () => {
  console.log(`${client.user.tag} aktif.`);
  client.user.setActivity('WYX Community');
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: require('./slash') });
  console.log('Slash komutları kaydedildi.');

  // Kalıcı çekiliş ve drop bitiş zamanlarını yeniden kur.
  const active = await Giveaway.find({ ended: false });
  for (const g of active) {
    const delay = Math.max(0, new Date(g.endsAt).getTime() - Date.now());
    setTimeout(() => finishGiveaway(g._id), Math.min(delay, 2147483000));
  }
  // Hatırlatıcılar restart sonrası da gönderilir.
  setInterval(async () => {
    const due = await Reminder.find({ sent: false, dueAt: { $lte: new Date() } }).limit(50);
    for (const r of due) {
      const user = await client.users.fetch(r.userId).catch(() => null);
      if (user) await user.send(`⏰ Hatırlatıcın: ${r.text}`).catch(() => null);
      r.sent = true; await r.save();
    }
  }, 15000);
  // Günlük Discord hesap açılış yıl dönümü kontrolü.
  setInterval(async () => {
    const now=new Date();
    const records=await Birthday.find({}).limit(1000);
    for(const b of records){
      if(!b.accountCreatedAt || b.accountCreatedAt.getUTCMonth()!==now.getUTCMonth() || b.accountCreatedAt.getUTCDate()!==now.getUTCDate()) continue;
      const stats=await UserStats.findOne({guildId:b.guildId,userId:b.userId});
      if(stats?.birthdayRewardYear===now.getUTCFullYear()) continue;
      const guild=await client.guilds.fetch(b.guildId).catch(()=>null);
      if(!guild) continue;
      await addXp(guild,b.userId,300);
      await UserStats.updateOne({guildId:b.guildId,userId:b.userId},{$set:{birthdayRewardYear:now.getUTCFullYear()}},{upsert:true});
      const user=await client.users.fetch(b.userId).catch(()=>null);
      await user?.send('🎂 Discord hesap yıl dönümün kutlu olsun! 300 XP kazandın.').catch(()=>null);
    }
  }, 3600000);

  // Haftalık XP sıfırlaması: pazartesi 00.00, TIMEZONE varsayılan Europe/Istanbul.
  setInterval(async () => {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: process.env.TIMEZONE || 'Europe/Istanbul', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
    const local = Object.fromEntries(parts.map(p=>[p.type,p.value]));
    if (local.weekday==='Mon' && local.hour==='00' && local.minute==='00') {
      const stamp = `${local.weekday}-${now.toISOString().slice(0,10)}`;
      if (client.lastWeeklyReset !== stamp) {
        await UserStats.updateMany({}, { $set: { weeklyXp: 0 } });
        client.lastWeeklyReset = stamp;
      }
    }
  }, 30000);
});

client.on('messageCreate', async message => {
  if (!message.guild || message.author.bot) return;
  const cfg = await configFor(message.guild.id);
  const prefix = cfg.prefix || client.prefix;

  // Mesaj istatistiği ve kısa süreli spam algılama.
  const wordCount = (message.content.trim().match(/\S+/g) || []).length;
  await GuildConfig.updateOne({ guildId: message.guild.id }, { $inc: { totalMessages: 1, totalWords: wordCount } });
  const spamKey = `${message.guild.id}:${message.author.id}`;
  const recent = (spamBuckets.get(spamKey) || []).filter(t => Date.now() - t < 5000);
  recent.push(Date.now()); spamBuckets.set(spamKey, recent);
  const spamHit = recent.length >= 6;

  // Filtre: seçilen karara uygun olarak yalnızca mesaj silinir.
  if (cfg.filters && (isFiltered(message.content) || spamHit) && !message.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
    await message.delete().catch(() => null);
    await log(message.guild, `🧹 Filtre nedeniyle mesaj silindi. Kullanıcı: <@${message.author.id}> | Kanal: <#${message.channel.id}>`, 0xEF4444);
    return;
  }

  // Mesaj XP: 5 dakikada en fazla bir kez, 1-10 XP.
  const stats = await UserStats.findOne({ guildId: message.guild.id, userId: message.author.id });
  if (!stats || !stats.lastMessageXpAt || Date.now() - stats.lastMessageXpAt.getTime() >= 300000) {
    await addXp(message.guild, message.author.id, Math.floor(Math.random()*10)+1, message.channel);
    await UserStats.updateOne({ guildId: message.guild.id, userId: message.author.id }, { $set: { lastMessageXpAt: new Date() } });
  }

  if (!message.content.startsWith(prefix)) return;
  const raw = message.content.slice(prefix.length).trim();
  if (!raw) return;
  const args = raw.split(/\s+/);
  const cmd = args.shift().toLocaleLowerCase('tr');
  const target = await mentionUser(message, args);
  const reason = args.slice(1).join(' ') || 'Sebep belirtilmedi.';

  try {
    switch (cmd) {
      case 'yardim':
      case 'help': {
        const embed = new EmbedBuilder().setColor(0x7C3AED).setTitle('WYX | Komut Listesi')
          .setDescription([
            '**Moderasyon:** `!ban`, `!kick`, `!mute`, `!warn`, `!warnings`, `!sil`, `!lock`, `!unlock`, `!sm`',
            '**Kurulum:** `!setup`, `!log`, `!g`, `!ç`, `!sayac`, `!ticketkategori-ekle`, `!ticketpanel`',
            '**XP:** `!topxp`, `!weekxp`, `!xp`',
            '**Eğlence:** `!cekilis`, `!drop`, `/anket`, `!tkm`, `!zar`, `!8ball`, `!avatar`, `!bilgi`, `!sunucu`',
            '**Topluluk:** `!öneri`, `!dogumgunu`, `!duyuru`, `!hatırlat`',
            '**Yönetim:** `!mesaj`, `!embed`, `/yetkili-basvuru`'
          ].join('\n'));
        return message.reply({ embeds: [embed] });
      }
      case 'setup': {
        if (!admin(message.member)) return message.reply('⛔ Yalnızca yöneticiler kullanabilir.');
        return setupPanel(message.channel, message.author.id);
      }
      case 'log': {
        if (!admin(message.member)) return message.reply('⛔ Yalnızca yöneticiler kullanabilir.');
        const ch = message.mentions.channels.first();
        if (!ch?.isTextBased()) return message.reply('Kullanım: `!log #kanal`');
        cfg.logChannelId = ch.id; await cfg.save();
        return message.reply(`✅ Log kanalı ${ch} olarak ayarlandı.`);
      }
      case 'g': {
        if (!admin(message.member)) return message.reply('⛔ Yalnızca yöneticiler kullanabilir.');
        cfg.welcomeChannelId = message.channel.id; await cfg.save();
        return message.reply('✅ Bu kanal hoş geldin kanalı olarak ayarlandı.');
      }
      case 'ç': {
        if (!admin(message.member)) return message.reply('⛔ Yalnızca yöneticiler kullanabilir.');
        cfg.leaveChannelId = message.channel.id; await cfg.save();
        return message.reply('✅ Bu kanal ayrılma kanalı olarak ayarlandı.');
      }
      case 'ban': {
        if (!await requirePermission(message, PermissionFlagsBits.BanMembers, 'Ban Members')) return;
        const user = target;
        if (!user) return message.reply('Kullanım: `!ban @üye [sebep]`');
        const member = await message.guild.members.fetch(user.id).catch(() => null);
        if (member && !member.bannable) return message.reply('Bu üyeyi banlayamıyorum. Bot rolünü ve yetkileri kontrol et.');
        await message.guild.members.ban(user.id, { reason });
        await log(message.guild, `🔨 <@${user.id}> yasaklandı. Yetkili: <@${message.author.id}> | Sebep: ${reason}`);
        return message.reply(`🔨 **${user.tag}** sunucudan yasaklandı.`);
      }
      case 'kick': {
        if (!await requirePermission(message, PermissionFlagsBits.KickMembers, 'Kick Members')) return;
        const member = message.mentions.members.first() || await message.guild.members.fetch(args[0]).catch(() => null);
        if (!member) return message.reply('Kullanım: `!kick @üye [sebep]`');
        if (!member.kickable) return message.reply('Bu üyeyi atamıyorum. Rol sıralamasını kontrol et.');
        await member.kick(reason);
        await log(message.guild, `👢 <@${member.id}> atıldı. Yetkili: <@${message.author.id}> | Sebep: ${reason}`);
        return message.reply(`👢 **${member.user.tag}** sunucudan atıldı.`);
      }
      case 'mute':
      case 'timeout': {
        if (!await requirePermission(message, PermissionFlagsBits.ModerateMembers, 'Moderate Members')) return;
        const member = message.mentions.members.first() || await message.guild.members.fetch(args[0]).catch(() => null);
        const duration = parseTime(args[1]);
        if (!member || !duration || duration > 28*86400000) return message.reply('Kullanım: `!mute @üye 10m [sebep]` (en fazla 28 gün)');
        if (!member.moderatable) return message.reply('Bu üyeye timeout uygulayamıyorum.');
        await member.timeout(duration, args.slice(2).join(' ') || 'Sebep belirtilmedi.');
        await log(message.guild, `🔇 <@${member.id}> timeout aldı. Yetkili: <@${message.author.id}>`);
        return message.reply(`🔇 ${member.user.tag} kullanıcısına timeout uygulandı.`);
      }
      case 'warn': {
        if (!await requirePermission(message, PermissionFlagsBits.ModerateMembers, 'Moderate Members')) return;
        if (!target) return message.reply('Kullanım: `!warn @üye [sebep]`');
        await Warning.create({ guildId: message.guild.id, userId: target.id, moderatorId: message.author.id, reason: args.slice(1).join(' ') || 'Sebep belirtilmedi.' });
        await log(message.guild, `⚠️ <@${target.id}> uyarıldı. Yetkili: <@${message.author.id}>`);
        return message.reply(`⚠️ ${target.tag} kullanıcısına uyarı kaydedildi.`);
      }
      case 'warnings': {
        if (!await requirePermission(message, PermissionFlagsBits.ModerateMembers, 'Moderate Members')) return;
        if (!target) return message.reply('Kullanım: `!warnings @üye`');
        const rows = await Warning.find({ guildId: message.guild.id, userId: target.id }).sort({ createdAt: -1 }).limit(10);
        return message.reply(rows.length ? `**${target.tag} uyarı geçmişi**\n${rows.map((w,i)=>`${i+1}. ${w.reason} — <@${w.moderatorId}> — <t:${Math.floor(w.createdAt.getTime()/1000)}:R>`).join('\n')}` : 'Uyarı kaydı bulunamadı.');
      }
      case 'sil': {
        if (!await requirePermission(message, PermissionFlagsBits.ManageMessages, 'Manage Messages')) return;
        const n = Number(args[0]);
        if (!Number.isInteger(n) || n < 1 || n > 100) return message.reply('Kullanım: `!sil 1-100`');
        const deleted = await message.channel.bulkDelete(n + 1, true);
        const note = await message.channel.send(`🧹 ${Math.max(0, deleted.size-1)} mesaj silindi.`);
        setTimeout(() => note.delete().catch(()=>null), 4000);
        return;
      }
      case 'lock':
      case 'unlock': {
        if (!await requirePermission(message, PermissionFlagsBits.ManageChannels, 'Manage Channels')) return;
        await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: cmd === 'lock' ? false : null });
        return message.reply(cmd === 'lock' ? '🔒 Kanal kilitlendi.' : '🔓 Kanal açıldı.');
      }
      case 'sm': {
        if (!await requirePermission(message, PermissionFlagsBits.ManageChannels, 'Manage Channels')) return;
        const n = Number(args[0]);
        if (!Number.isInteger(n) || n < 0 || n > 21600) return message.reply('Kullanım: `!sm 0-21600`');
        await message.channel.setRateLimitPerUser(n);
        return message.reply(`⏱️ Slowmode ${n} saniye olarak ayarlandı.`);
      }
      case 'topxp':
      case 'weekxp': {
        const key = cmd === 'topxp' ? 'totalXp' : 'weeklyXp';
        const rows = await UserStats.find({ guildId: message.guild.id }).sort({ [key]: -1 }).limit(10);
        const lines = await Promise.all(rows.map(async (r,i) => {
          const u = await client.users.fetch(r.userId).catch(()=>null);
          return `**${i+1}.** ${u?.tag || r.userId} — **${r[key]} XP**`;
        }));
        return message.reply(`🏆 **${cmd === 'topxp' ? 'Genel' : 'Haftalık'} XP sıralaması**\n${lines.join('\n') || 'Henüz veri yok.'}`);
      }
      case 'xp': {
        if (!admin(message.member)) return message.reply('⛔ Yalnızca yöneticiler kullanabilir.');
        return message.reply('XP rolü ayarlamak için `/xp xp:<eşik> rol:<rol>` komutunu kullan. Desteklenen eşikler: 500, 3000, 7000, 10000, 30000.');
      }
      case 'cekilis': {
        if (!isStaff(message.member)) return message.reply('⛔ Yetkili izni gerekiyor.');
        const duration = parseTime(args[args.length - 1]);
        const winners = Number(args[args.length - 2]);
        const fullPrize = args.slice(0, -2).join(' ').replaceAll('_',' ');
        if (!fullPrize || !Number.isInteger(winners) || winners < 1 || winners > 20 || !duration) return message.reply('Kullanım: `!cekilis <ödül> <kazanan sayısı> <1d|1h|1m|1s>`');
        const endsAt = new Date(Date.now()+duration);
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('giveaway_join').setLabel('Çekilişe Katıl').setStyle(ButtonStyle.Success));
        const embed = new EmbedBuilder().setColor(0xF59E0B).setTitle('🎉 ÇEKİLİŞ').setDescription(`Ödül: **${fullPrize}**\nKazanan sayısı: **${winners}**\nBitiş: <t:${Math.floor(endsAt.getTime()/1000)}:R>\nKatılmak için butona bas!`);
        const msg = await message.channel.send({ embeds:[embed], components:[row] });
        const g = await Giveaway.create({ guildId: message.guild.id, channelId: message.channel.id, messageId: msg.id, prize: fullPrize, winnersCount: winners, endsAt });
        setTimeout(()=>finishGiveaway(g._id), Math.min(duration,2147483000));
        return;
      }
      case 'drop': {
        if (!isStaff(message.member)) return message.reply('⛔ Yetkili izni gerekiyor.');
        const prize = args.join(' ');
        if (!prize) return message.reply('Kullanım: `!drop <ödül>`');
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('drop_claim_pending').setLabel('Ödülü kap!').setStyle(ButtonStyle.Primary));
        const msg = await message.channel.send({ content:`🎁 **DROP!**\nÖdül: **${prize}**\nİlk basan kazanır!`, components:[row] });
        const d = await Drop.create({ guildId: message.guild.id, channelId: message.channel.id, messageId: msg.id, prize });
        await msg.edit({ components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`drop_claim:${d._id}`).setLabel('Ödülü kap!').setStyle(ButtonStyle.Primary))] });
        return;
      }
      case 'zar': {
        const n = Number(args[0]);
        if (!Number.isInteger(n) || n < 1 || n > 5) return message.reply('Kullanım: `!zar 1-5`');
        const vals = Array.from({length:n},(_,i)=>`${i+1}. zar: **${Math.floor(Math.random()*6)+1}**`);
        return message.reply(`🎲 ${vals.join('\n')}`);
      }
      case '8ball': {
        const q = args.join(' ');
        if (!q) return message.reply('Bir soru yazmalısın. Örnek: `!8ball Bugün şanslı mıyım?`');
        const answers = ['Kesinlikle evet.', 'Büyük ihtimalle.', 'Bunu zaman gösterecek.', 'Şu an emin değilim.', 'Pek sanmıyorum.', 'Kesinlikle hayır.'];
        return message.reply(`🎱 ${answers[Math.floor(Math.random()*answers.length)]}`);
      }
      case 'avatar': {
        const u = target || message.author;
        return message.reply({ embeds:[new EmbedBuilder().setColor(0x7C3AED).setTitle(`${u.tag} | Avatar`).setImage(u.displayAvatarURL({size:1024}))] });
      }
      case 'bilgi': {
        const u = target || message.author;
        return message.reply(`**${u.tag}**\nHesap yaşı: <t:${Math.floor(u.createdTimestamp/1000)}:R>\nID: \`${u.id}\``);
      }
      case 'sunucu': {
        const members = await message.guild.members.fetch();
        const bots = members.filter(m=>m.user.bot).size;
        return message.reply({ embeds:[new EmbedBuilder().setColor(0x7C3AED).setTitle(message.guild.name)
          .addFields(
            {name:'Kurucu',value:`<@${message.guild.ownerId}>`,inline:true},
            {name:'Üye',value:String(message.guild.memberCount),inline:true},
            {name:'Bot',value:String(bots),inline:true},
            {name:'Toplam mesaj',value:String(cfg.totalMessages || 0),inline:true},
            {name:'Yazılan kelime',value:String(cfg.totalWords || 0),inline:true}
          ).setThumbnail(message.guild.iconURL({size:256}))] });
      }
      case 'öneri': {
        const text = args.join(' ');
        if (!text) return message.reply('Kullanım: `!öneri <önerin>`');
        if (!cfg.suggestionChannelId) return message.reply('Öneri kanalı henüz ayarlanmamış. `/setup` kullan.');
        const ch = await message.guild.channels.fetch(cfg.suggestionChannelId).catch(()=>null);
        if (!ch?.isTextBased()) return message.reply('Öneri kanalı bulunamadı.');
        const embed = new EmbedBuilder().setColor(0x7C3AED).setTitle('💡 Yeni Öneri').setDescription(text).setFooter({text:`Gönderen: ${message.author.tag}`});
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('suggest_up_pending').setLabel('Olumlu 0').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('suggest_down_pending').setLabel('Olumsuz 0').setStyle(ButtonStyle.Danger)
        );
        const m = await ch.send({embeds:[embed],components:[row]});
        const s = await Suggestion.create({guildId:message.guild.id,channelId:ch.id,messageId:m.id,authorId:message.author.id,text});
        await m.edit({components:[new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`suggest_up:${s._id}`).setLabel('Olumlu 0').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`suggest_down:${s._id}`).setLabel('Olumsuz 0').setStyle(ButtonStyle.Danger)
        )]});
        return message.reply('✅ Önerin gönderildi.');
      }
      case 'dogumgunu': {
        await Birthday.findOneAndUpdate({guildId:message.guild.id,userId:message.author.id},
          {guildId:message.guild.id,userId:message.author.id,accountCreatedAt:message.author.createdAt},{upsert:true});
        return message.reply('🎂 Discord hesap yıl dönümü ödülüne kaydoldun. Hesabının açılış yıl dönümünde 300 XP kazanacaksın.');
      }
      case 'duyuru': {
        if (!admin(message.member)) return message.reply('⛔ Yalnızca yöneticiler kullanabilir.');
        const text = args.join(' ');
        if (!text) return message.reply('Kullanım: `!duyuru <mesaj>`');
        if (!cfg.announcementChannelId) return message.reply('Duyuru kanalı `/setup` üzerinden ayarlanmalı.');
        const announce = await message.guild.channels.fetch(cfg.announcementChannelId).catch(()=>null);
        if (announce?.isTextBased()) await announce.send({content:`@everyone @here\n${text}`,allowedMentions:{parse:['everyone']}});
        if (cfg.chatChannelId) {
          const chat = await message.guild.channels.fetch(cfg.chatChannelId).catch(()=>null);
          if (chat?.isTextBased()) await chat.send({content:text,allowedMentions:{parse:[]}});
        }
        await message.delete().catch(()=>null);
        return;
      }
      case 'hatırlat':
      case 'hatirlat': {
        const duration = parseTime(args[0]);
        const text = args.slice(1).join(' ');
        if (!duration || !text) return message.reply('Kullanım: `!hatırlat 1h <mesaj>`');
        const r = await Reminder.create({userId:message.author.id,guildId:message.guild.id,text,dueAt:new Date(Date.now()+duration)});
        return message.reply(`⏰ Hatırlatıcın kaydedildi. <t:${Math.floor(r.dueAt.getTime()/1000)}:R> sana DM göndereceğim.`);
      }
      case 'mesaj': {
        if (!admin(message.member)) return message.reply('⛔ Yalnızca yöneticiler kullanabilir.');
        const text = args.join(' ');
        if (!text) return message.reply('Kullanım: `!mesaj <metin>`');
        await message.delete().catch(()=>null);
        return message.channel.send({content:text,allowedMentions:{parse:[]}});
      }
      case 'embed': {
        if (!admin(message.member)) return message.reply('⛔ Yalnızca yöneticiler kullanabilir.');
        const text = args.join(' ');
        if (!text) return message.reply('Kullanım: `!embed <metin>`');
        const embed = new EmbedBuilder().setColor(0x7C3AED).setDescription(text).setTimestamp();
        await message.delete().catch(()=>null);
        return message.channel.send({embeds:[embed],allowedMentions:{parse:[]}});
      }
      case 'ticketkategori-ekle': {
        if (!admin(message.member)) return message.reply('⛔ Yalnızca yöneticiler kullanabilir.');
        const name = args.join(' ').trim();
        if (!name) return message.reply('Kullanım: `!ticketkategori-ekle Genel Destek`');
        if (cfg.ticketCategories.length >= 10) return message.reply('En fazla 10 ticket kategorisi ekleyebilirsin.');
        cfg.ticketCategories.push(name.slice(0,80)); await cfg.save();
        return message.reply(`✅ Ticket kategorisi eklendi: **${name}**`);
      }
      case 'ticketpanel': {
        if (!admin(message.member)) return message.reply('⛔ Yalnızca yöneticiler kullanabilir.');
        cfg.ticketPanelChannelId = message.channel.id; await cfg.save();
        return createTicketPanel(message.channel,message.guild);
      }
      case 'ticket-sil': {
        if (!admin(message.member)) return message.reply('⛔ Yalnızca yöneticiler kullanabilir.');
        const ticket=await Ticket.findOne({channelId:message.channel.id});
        if(!ticket) return message.reply('Bu kanal bir ticket değil.');
        await message.reply('🗑️ Ticket kanalı yönetici tarafından siliniyor.');
        await Ticket.deleteOne({_id:ticket._id});
        return message.channel.delete('WYX ticket yönetici tarafından silindi.').catch(()=>null);
      }
      case 'sayac': {
        if (!admin(message.member)) return message.reply('⛔ Yalnızca yöneticiler kullanabilir.');
        const category = await message.guild.channels.create({name:'SUNUCU BİLGİ',type:ChannelType.GuildCategory});
        const members = await message.guild.members.fetch();
        const bots = members.filter(m=>m.user.bot).size;
        for (const [name,value] of [['üye-sayısı',message.guild.memberCount],['bot-sayısı',bots],['insan-sayısı',members.size-bots]]) {
          await message.guild.channels.create({name:`${name}: ${value}`,type:ChannelType.GuildVoice,parent:category.id,permissionOverwrites:[
            {id:message.guild.roles.everyone.id,deny:[PermissionFlagsBits.Connect,PermissionFlagsBits.Speak],allow:[PermissionFlagsBits.ViewChannel]}
          ]}).catch(()=>null);
        }
        return message.reply('✅ Sunucu bilgi sayaçları oluşturuldu.');
      }
      case 'rr': {
        if(!admin(message.member)) return message.reply('⛔ Yalnızca yöneticiler kullanabilir.');
        const role=message.mentions.roles.first();
        const emoji=args.find(x=>/^\p{Extended_Pictographic}/u.test(x));
        const text=args.filter(x=>x!==`<@&${role?.id}>`&&x!==emoji).join(' ')||'Rol almak için emojiye tıkla.';
        if(!role||!emoji) return message.reply('Kullanım: `!rr @rol 😀 açıklama`');
        const msg=await message.channel.send({embeds:[new EmbedBuilder().setColor(0x7C3AED).setDescription(text)]});
        await msg.react(emoji).catch(()=>null);
        const reaction=msg.reactions.cache.find(r=>r.emoji.name===emoji);
        if(!reaction) return message.reply('Emoji eklenemedi.');
        await ReactionRole.create({guildId:message.guild.id,channelId:message.channel.id,messageId:msg.id,emoji:reaction.emoji.name,roleId:role.id});
        return message.reply('✅ Reaction Role oluşturuldu.');
      }
      case 'tkm': {
        const opponent = message.mentions.users.first();
        if (!opponent || opponent.bot || opponent.id===message.author.id) return message.reply('Kullanım: `!tkm @kullanıcı`');
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('tkm_accept_pending').setLabel('Kabul et').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('tkm_decline_pending').setLabel('Reddet').setStyle(ButtonStyle.Danger)
        );
        const msg = await message.channel.send({content:`${opponent}, ${message.author} seninle taş-kağıt-makas oynamak istiyor.`,components:[row]});
        const game = await Tkm.create({guildId:message.guild.id,channelId:message.channel.id,messageId:msg.id,challengerId:message.author.id,opponentId:opponent.id});
        await msg.edit({components:[new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`tkm_accept:${game._id}`).setLabel('Kabul et').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`tkm_decline:${game._id}`).setLabel('Reddet').setStyle(ButtonStyle.Danger)
        )]});
        return;
      }
      default:
        return;
    }
  } catch (error) {
    console.error(`Komut ${cmd} hatası:`, error);
    return message.reply('❌ İşlem sırasında hata oluştu. Bot izinlerini ve rol sıralamasını kontrol et.').catch(()=>null);
  }
});

client.on('voiceStateUpdate', async (oldState,newState) => {
  const member = newState.member || oldState.member;
  if (!member || member.user.bot || !newState.guild) return;
  const key = `${newState.guild.id}:${member.id}`;
  if (newState.channelId) {
    if (!voiceTimers.has(key)) {
      const timer = setInterval(async () => {
        const current = await newState.guild.members.fetch(member.id).catch(()=>null);
        if (!current?.voice.channelId) { clearInterval(timer); voiceTimers.delete(key); return; }
        // Kullanıcı ses kanalında bulunduğu sürece 10-17 XP; AFK kanalı da ses aktivitesi olarak sayılmaz.
        const afk = newState.guild.afkChannelId;
        if (current.voice.channelId === afk) return;
        await addXp(newState.guild, member.id, Math.floor(Math.random()*8)+10, current.voice.channel);
      },300000);
      voiceTimers.set(key,timer);
    }
  } else if (!newState.channelId && voiceTimers.has(key)) {
    clearInterval(voiceTimers.get(key)); voiceTimers.delete(key);
  }
});

async function refreshCounters(guild) {
  const category=guild.channels.cache.find(c=>c.type===ChannelType.GuildCategory && c.name==='SUNUCU BİLGİ');
  if(!category) return;
  const members=await guild.members.fetch().catch(()=>null);
  if(!members) return;
  const bots=members.filter(m=>m.user.bot).size;
  const values={'üye-sayısı':guild.memberCount,'bot-sayısı':bots,'insan-sayısı':members.size-bots};
  for(const [key,value] of Object.entries(values)){
    const channel=guild.channels.cache.find(c=>c.parentId===category.id && c.name.startsWith(`${key}:`));
    if(channel && channel.name!==`${key}: ${value}`) await channel.setName(`${key}: ${value}`).catch(()=>null);
  }
}

client.on('guildMemberAdd', async member => {
  const cfg = await configFor(member.guild.id);
  if (cfg.autoroleId) {
    const role = await member.guild.roles.fetch(cfg.autoroleId).catch(()=>null);
    if (role?.editable) await member.roles.add(role).catch(()=>null);
  }
  const ageDays = (Date.now()-member.user.createdTimestamp)/86400000;
  if (ageDays < 7 && cfg.quarantineRoleId) {
    const role = await member.guild.roles.fetch(cfg.quarantineRoleId).catch(()=>null);
    if (role?.editable) await member.roles.add(role).catch(()=>null);
    await log(member.guild,`🟠 Şüpheli yeni hesap karantinaya alındı: <@${member.id}> (${Math.floor(ageDays)} günlük hesap)`,0xF59E0B);
  }
  const now = Date.now();
  const bucket = (joinBuckets.get(member.guild.id)||[]).filter(t=>now-t<15000);
  bucket.push(now); joinBuckets.set(member.guild.id,bucket);
  if (bucket.length>=10) {
    const old = member.guild.verificationLevel;
    await member.guild.setVerificationLevel(GuildVerificationLevel.VeryHigh,'WYX Anti-Raid: 15 saniyede 10 katılım').catch(()=>null);
    cfg.raidProtectionUntil = new Date(now+600000);
    cfg.raidOldVerificationLevel = old;
    await cfg.save();
    await log(member.guild,'🚨 Anti-Raid tetiklendi: 15 saniyede 10 katılım algılandı. Doğrulama seviyesi 10 dakika yükseltildi.',0xEF4444);
    setTimeout(async()=>{
      const latest=await configFor(member.guild.id);
      if (latest.raidProtectionUntil && latest.raidProtectionUntil<=new Date()) {
        if (latest.raidOldVerificationLevel) await member.guild.setVerificationLevel(latest.raidOldVerificationLevel,'WYX Anti-Raid koruması sona erdi').catch(()=>null);
        latest.raidProtectionUntil=null; latest.raidOldVerificationLevel=null; await latest.save();
        await log(member.guild,'🛡️ Anti-Raid geçici koruması sona erdi.');
      }
    },600000);
  }
  // Anti-Bot: 15 saniyede 10 bot hesabı katılırsa aynı 10 dakikalık giriş koruması devreye girer.
  if (member.user.bot) {
    const botBucket=(botJoinBuckets.get(member.guild.id)||[]).filter(t=>now-t<15000);
    botBucket.push(now); botJoinBuckets.set(member.guild.id,botBucket);
    if(botBucket.length>=10){
      const previous=member.guild.verificationLevel;
      await member.guild.setVerificationLevel(GuildVerificationLevel.VeryHigh,'WYX Anti-Bot: 15 saniyede 10 bot katılımı').catch(()=>null);
      cfg.raidProtectionUntil=new Date(now+600000); cfg.raidOldVerificationLevel=previous; await cfg.save();
      await log(member.guild,'🤖🚨 Anti-Bot tetiklendi: 15 saniyede 10 bot hesabı katıldı. Giriş doğrulaması 10 dakika yükseltildi.',0xEF4444);
    }
  }

  if (cfg.welcomeChannelId) {
    const ch=await member.guild.channels.fetch(cfg.welcomeChannelId).catch(()=>null);
    if (ch?.isTextBased()) {
      const embed=new EmbedBuilder().setColor(0x7C3AED).setTitle('Aramıza hoş geldin!')
        .setDescription(`${member} sunucuya katıldı.`)
        .addFields({name:'Hesap açılışı',value:`<t:${Math.floor(member.user.createdTimestamp/1000)}:R>`,inline:true},
          {name:'Hesap güvenilirliği',value:ageDays<7?'Yeni hesap — inceleme gerekli':'Hesap yaşı 7 günden büyük',inline:true},
          {name:'Üye sayısı',value:String(member.guild.memberCount),inline:true})
        .setThumbnail(member.user.displayAvatarURL({size:256})).setTimestamp();
      await ch.send({embeds:[embed]}).catch(()=>null);
    }
  }
  await log(member.guild,`📥 Üye katıldı: <@${member.id}>`);
  await refreshCounters(member.guild);
  // Discord hesabı açılış yıl dönümü ödülü.
  const birthday=await Birthday.findOne({guildId:member.guild.id,userId:member.id});
  if (birthday && birthday.accountCreatedAt.getUTCMonth()===new Date().getUTCMonth() &&
      birthday.accountCreatedAt.getUTCDate()===new Date().getUTCDate()) {
    const stats=await UserStats.findOne({guildId:member.guild.id,userId:member.id});
    const year=new Date().getUTCFullYear();
    if (!stats || stats.birthdayRewardYear!==year) {
      await addXp(member.guild,member.id,300);
      await UserStats.updateOne({guildId:member.guild.id,userId:member.id},{$set:{birthdayRewardYear:year}},{upsert:true});
      await member.send('🎂 Discord hesabının açılış yıl dönümü kutlu olsun! 300 XP kazandın.').catch(()=>null);
    }
  }
});

client.on('guildMemberRemove', async member => {
  const cfg=await configFor(member.guild.id);
  if(cfg.leaveChannelId){
    const ch=await member.guild.channels.fetch(cfg.leaveChannelId).catch(()=>null);
    if(ch?.isTextBased()){
      const embed=new EmbedBuilder().setColor(0xEF4444).setTitle('Bir üyemiz ayrıldı')
        .setDescription(`**${member.user.tag}** sunucudan ayrıldı.`)
        .setThumbnail(member.user.displayAvatarURL({size:256})).setFooter({text:`Kalan üye: ${member.guild.memberCount}`}).setTimestamp();
      await ch.send({embeds:[embed]}).catch(()=>null);
    }
  }
  await log(member.guild,`📤 Üye ayrıldı: ${member.user.tag}`);
  await refreshCounters(member.guild);
});

client.on('guildAuditLogEntryCreate', async (entry,guild) => {
  const protectedActions = [AuditLogEvent.ChannelDelete,AuditLogEvent.RoleDelete,AuditLogEvent.MemberBanAdd,AuditLogEvent.WebhookCreate,AuditLogEvent.BotAdd];
  if (!protectedActions.includes(entry.action) || !entry.executorId || entry.executorId===client.user.id) return;
  const actor=await guild.members.fetch(entry.executorId).catch(()=>null);
  if (!actor || actor.id===guild.ownerId) {
    await log(guild,`📋 Audit: ${entry.action} işlemi ${entry.executor?.tag || entry.executorId} tarafından yapıldı.`);
    return;
  }
  const recent=await guild.fetchAuditLogs({limit:8}).catch(()=>null);
  const same=recent?.entries.filter(e=>e.executorId===entry.executorId && Date.now()-e.createdTimestamp<10000).size||0;
  if (same>=3) {
    for (const role of actor.roles.cache.values()) {
      if (role.id!==guild.id && role.editable && !role.managed) await actor.roles.remove(role).catch(()=>null);
    }
    await actor.kick('WYX Anti-Nuke: kısa sürede çok sayıda korunan işlem').catch(()=>null);
    await log(guild,`🚨 Anti-Nuke müdahalesi: <@${actor.id}> kullanıcısının yetkileri kaldırılmaya çalışıldı ve sunucudan atıldı.`,0xEF4444);
  } else {
    await log(guild,`⚠️ Korunan işlem algılandı: ${entry.action} — <@${entry.executorId}>`);
  }
});

client.on('messageReactionAdd', async (reaction,user) => {
  if(user.bot) return;
  if(reaction.partial) await reaction.fetch().catch(()=>null);
  const rr=await ReactionRole.findOne({messageId:reaction.message.id,emoji:reaction.emoji.name});
  if(!rr) return;
  const guild=await client.guilds.fetch(rr.guildId).catch(()=>null);
  const member=await guild?.members.fetch(user.id).catch(()=>null);
  const role=await guild?.roles.fetch(rr.roleId).catch(()=>null);
  if(member&&role?.editable) await member.roles.add(role).catch(()=>null);
});
client.on('messageReactionRemove', async (reaction,user) => {
  if(user.bot) return;
  if(reaction.partial) await reaction.fetch().catch(()=>null);
  const rr=await ReactionRole.findOne({messageId:reaction.message.id,emoji:reaction.emoji.name});
  if(!rr) return;
  const guild=await client.guilds.fetch(rr.guildId).catch(()=>null);
  const member=await guild?.members.fetch(user.id).catch(()=>null);
  const role=await guild?.roles.fetch(rr.roleId).catch(()=>null);
  if(member&&role?.editable) await member.roles.remove(role).catch(()=>null);
});

client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      const cfg=await configFor(interaction.guildId);
      if (interaction.commandName==='setup') {
        if (!admin(interaction.member)) return interaction.reply({content:'Yalnızca yöneticiler kullanabilir.',ephemeral:true});
        await setupPanel(interaction.channel,interaction.user.id);
        return interaction.reply({content:'Kurulum paneli gönderildi.',ephemeral:true});
      }
      if (interaction.commandName==='log') {
        if (!admin(interaction.member)) return interaction.reply({content:'Yalnızca yöneticiler kullanabilir.',ephemeral:true});
        const ch=interaction.options.getChannel('kanal');
        cfg.logChannelId=ch.id; await cfg.save();
        return interaction.reply({content:`Log kanalı ${ch} olarak ayarlandı.`,ephemeral:true});
      }
      if (interaction.commandName==='anket') {
        const question=interaction.options.getString('soru');
        const choices=interaction.options.getString('secenekler').split('|').map(s=>s.trim()).filter(Boolean);
        if(choices.length<2||choices.length>6) return interaction.reply({content:'Ankette 2-6 seçenek olmalı.',ephemeral:true});
        const embed=new EmbedBuilder().setColor(0x7C3AED).setTitle('📊 Anket').setDescription(`**${question}**\n\n${choices.map((x,i)=>`${i+1}. ${x}`).join('\n')}`);
        await interaction.reply({embeds:[embed],fetchReply:true});
        const pollMessage=await interaction.fetchReply();
        const poll=await Poll.create({guildId:interaction.guildId,channelId:interaction.channelId,messageId:pollMessage.id,question,options:choices,votes:{}});
        const row=new ActionRowBuilder().addComponents(choices.map((x,i)=>new ButtonBuilder().setCustomId(`poll:${poll._id}:${i}`).setLabel(`${i+1}. ${x.slice(0,55)} (0)`).setStyle(ButtonStyle.Primary)));
        await pollMessage.edit({components:[row]});
        return;
      }
      if (interaction.commandName==='ticketpanel') {
        if(!admin(interaction.member)) return interaction.reply({content:'Yalnızca yöneticiler kullanabilir.',ephemeral:true});
        await createTicketPanel(interaction.channel,interaction.guild);
        return interaction.reply({content:'Ticket paneli gönderildi.',ephemeral:true});
      }
      if (interaction.commandName==='yetkili-basvuru') {
        if(!admin(interaction.member)) return interaction.reply({content:'Yalnızca yöneticiler kullanabilir.',ephemeral:true});
        const row=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('application_start').setLabel('Yetkili Başvurusu').setStyle(ButtonStyle.Primary));
        await interaction.channel.send({content:'Yetkili olmak için başvuru formunu doldur:',components:[row]});
        return interaction.reply({content:'Başvuru paneli gönderildi.',ephemeral:true});
      }
      if (interaction.commandName==='ticket-yetkili') {
        if(!admin(interaction.member)) return interaction.reply({content:'Yalnızca yöneticiler kullanabilir.',ephemeral:true});
        const role=interaction.options.getRole('rol');
        if(!cfg.ticketSupportRoleIds.includes(role.id)) cfg.ticketSupportRoleIds.push(role.id);
        await cfg.save();
        return interaction.reply({content:`${role} ticket yetkilisi olarak eklendi.`,ephemeral:true});
      }
      if (interaction.commandName==='basvuru-ayarla') {
        if(!admin(interaction.member)) return interaction.reply({content:'Yalnızca yöneticiler kullanabilir.',ephemeral:true});
        const questions=interaction.options.getString('sorular').split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
        if(questions.length<1||questions.length>10) return interaction.reply({content:'1-10 arasında soru girmelisin. Her soruyu ayrı satıra yaz.',ephemeral:true});
        cfg.applicationQuestions=questions; cfg.applicationRoleId=interaction.options.getRole('rol').id; await cfg.save();
        return interaction.reply({content:`${questions.length} başvuru sorusu ve kabul rolü kaydedildi.`,ephemeral:true});
      }
      if (interaction.commandName==='dogumgunu') {
        await Birthday.findOneAndUpdate({guildId:interaction.guildId,userId:interaction.user.id},{guildId:interaction.guildId,userId:interaction.user.id,accountCreatedAt:interaction.user.createdAt},{upsert:true});
        return interaction.reply({content:'Hesap yıl dönümü ödülüne kaydoldun.',ephemeral:true});
      }
      if (interaction.commandName==='xp') {
        if(!admin(interaction.member)) return interaction.reply({content:'Yalnızca yöneticiler kullanabilir.',ephemeral:true});
        const xp=interaction.options.getInteger('xp'), role=interaction.options.getRole('rol');
        if(![500,3000,7000,10000,30000].includes(xp)) return interaction.reply({content:'Desteklenen XP eşikleri: 500, 3000, 7000, 10000, 30000.',ephemeral:true});
        cfg.xpRoleRules=cfg.xpRoleRules.filter(r=>r.xp!==xp); cfg.xpRoleRules.push({xp,roleId:role.id}); await cfg.save();
        return interaction.reply({content:`${xp} XP için ${role} rolü kaydedildi.`,ephemeral:true});
      }
      if (interaction.commandName==='yardim') return interaction.reply({content:'Komutlar: `!ban !kick !mute !warn !warnings !sil !lock !unlock !sm !topxp !weekxp !cekilis !drop !tkm !zar !8ball !avatar !bilgi !sunucu !öneri !dogumgunu !duyuru !hatırlat !mesaj !embed !ticketpanel !sayac`',ephemeral:true});
    }

    if (interaction.isStringSelectMenu()) {
      if (interaction.customId.startsWith('setup_select:')) {
        const owner=interaction.customId.split(':')[1];
        if(interaction.user.id!==owner) return interaction.reply({content:'Bu kurulum paneli başka bir yöneticiye ait.',ephemeral:true});
        const key=interaction.values[0];
        if(['autorole','quarantine','applicationRole','ticketSupportRole'].includes(key)){
          const menu=new RoleSelectMenuBuilder().setCustomId(`setup_role:${key}:${owner}`).setPlaceholder('Rol seç');
          return interaction.reply({content:'Bir rol seç:',components:[new ActionRowBuilder().addComponents(menu)],ephemeral:true});
        }
        const menu=new ChannelSelectMenuBuilder().setCustomId(`setup_channel:${key}:${owner}`).setPlaceholder('Kanal seç').addChannelTypes(ChannelType.GuildText);
        return interaction.reply({content:'Bir kanal seç:',components:[new ActionRowBuilder().addComponents(menu)],ephemeral:true});
      }
      if(interaction.customId==='ticket_create'){
        const cfg=await configFor(interaction.guildId);
        const open=await Ticket.findOne({guildId:interaction.guildId,ownerId:interaction.user.id,status:'open'});
        if(open) return interaction.reply({content:`Zaten açık bir ticketin var: <#${open.channelId}>`,ephemeral:true});
        const category=cfg.ticketCategories[Number(interaction.values[0])]||'Genel Destek';
        const supportRole=cfg.ticketSupportRoleIds[0];
        const overwrites=[
          {id:interaction.guild.roles.everyone.id,deny:[PermissionFlagsBits.ViewChannel]},
          {id:interaction.user.id,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory]},
          {id:client.user.id,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ManageChannels,PermissionFlagsBits.ReadMessageHistory]}
        ];
        if(supportRole) overwrites.push({id:supportRole,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory]});
        const ch=await interaction.guild.channels.create({name:`ticket-${interaction.user.username}`.toLowerCase().replace(/[^a-z0-9-]/g,'').slice(0,90),type:ChannelType.GuildText,permissionOverwrites:overwrites});
        await Ticket.create({guildId:interaction.guildId,channelId:ch.id,ownerId:interaction.user.id,category});
        const row=new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('ticket_claim').setLabel('Sahiplen').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('ticket_help').setLabel('Yetkili Yardım').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('ticket_close').setLabel('Kapat').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('ticket_transfer').setLabel('Devret').setStyle(ButtonStyle.Secondary)
        );
        await ch.send({content:`<@${interaction.user.id}> | **${category}**\nDestek talebin oluşturuldu.`,components:[row]});
        return interaction.reply({content:`Ticket oluşturuldu: ${ch}`,ephemeral:true});
      }
      if(interaction.customId.startsWith('poll:')){
        return interaction.reply({content:'Anket oylama butonları bu sürümde görsel olarak oluşturulur; kalıcı oy sayımı sonraki bakım güncellemesinde etkinleştirilecek.',ephemeral:true});
      }
    }

    if(interaction.isRoleSelectMenu() && interaction.customId.startsWith('setup_role:')){
      const [,key,owner]=interaction.customId.split(':');
      if(interaction.user.id!==owner) return interaction.reply({content:'Bu panel sana ait değil.',ephemeral:true});
      const cfg=await configFor(interaction.guildId);
      if(key==='autorole') cfg.autoroleId=interaction.values[0];
      else if(key==='quarantine') cfg.quarantineRoleId=interaction.values[0];
      else if(key==='applicationRole') cfg.applicationRoleId=interaction.values[0];
      else if(key==='ticketSupportRole'&&!cfg.ticketSupportRoleIds.includes(interaction.values[0])) cfg.ticketSupportRoleIds.push(interaction.values[0]);
      await cfg.save();
      return interaction.reply({content:'Rol ayarı kaydedildi.',ephemeral:true});
    }
    if(interaction.isChannelSelectMenu() && interaction.customId.startsWith('setup_channel:')){
      const [,key,owner]=interaction.customId.split(':');
      if(interaction.user.id!==owner) return interaction.reply({content:'Bu panel sana ait değil.',ephemeral:true});
      const cfg=await configFor(interaction.guildId);
      const map={log:'logChannelId',welcome:'welcomeChannelId',leave:'leaveChannelId',suggestion:'suggestionChannelId',announcement:'announcementChannelId',chat:'chatChannelId',application:'applicationChannelId',ticketpanel:'ticketPanelChannelId'};
      cfg[map[key]]=interaction.values[0]; await cfg.save();
      if(key==='ticketpanel') await createTicketPanel(await interaction.guild.channels.fetch(interaction.values[0]),interaction.guild);
      return interaction.reply({content:'Kanal ayarı kaydedildi.',ephemeral:true});
    }

    if(interaction.isButton()){
      const id=interaction.customId;
      if(id==='application_start'){
        const cfg=await configFor(interaction.guildId);
        if(!cfg.applicationQuestions.length) return interaction.reply({content:'Başvuru soruları henüz yönetici tarafından ayarlanmamış.',ephemeral:true});
        await interaction.reply({content:'Başvuru sorularını DM üzerinden gönderdim. DM ayarların kapalıysa başvuru başlayamaz.',ephemeral:true});
        const dm=await interaction.user.createDM();
        const answers=[];
        await dm.send(`WYX yetkili başvurusu başladı. Toplam ${cfg.applicationQuestions.length} soru var. Her soruya 3 dakika içinde cevap ver.`);
        for(let i=0;i<cfg.applicationQuestions.length;i++){
          await dm.send(`**${i+1}/${cfg.applicationQuestions.length}. Soru**\n${cfg.applicationQuestions[i]}`);
          const collected=await dm.awaitMessages({filter:m=>m.author.id===interaction.user.id, max:1, time:180000});
          if(!collected.size){await dm.send('Süre dolduğu için başvurun iptal edildi.');return;}
          answers.push(collected.first().content.slice(0,1500));
        }
        const app=await Application.create({guildId:interaction.guildId,userId:interaction.user.id,answers});
        const sent=await sendApplicationDM(app).catch(()=>false);
        if(!sent){await dm.send('Başvuru kurucuya iletilemedi. Lütfen daha sonra tekrar dene.');return;}
        await dm.send('Başvurun kurucuya gönderildi. Sonuç DM üzerinden bildirilecek.');
        return;
      }
      if(id.startsWith('app_accept:')||id.startsWith('app_reject:')){
        if(interaction.user.id!==process.env.OWNER_ID) return interaction.reply({content:'Bu kararı yalnızca bot kurucusu verebilir.',ephemeral:true});
        const [,appId]=id.split(':'); const app=await Application.findById(appId);
        if(!app||app.status!=='pending') return interaction.reply({content:'Başvuru bulunamadı veya daha önce sonuçlandırıldı.',ephemeral:true});
        app.status=id.startsWith('app_accept:')?'accepted':'rejected'; await app.save();
        if(app.status==='accepted'){
          const guild=await client.guilds.fetch(app.guildId).catch(()=>null);
          const cfg=await configFor(app.guildId);
          const member=await guild?.members.fetch(app.userId).catch(()=>null);
          const role=cfg.applicationRoleId?await guild.roles.fetch(cfg.applicationRoleId).catch(()=>null):null;
          if(member&&role?.editable) await member.roles.add(role).catch(()=>null);
          await member?.send('✅ Yetkili başvurun kabul edildi.').catch(()=>null);
        } else {
          const user=await client.users.fetch(app.userId).catch(()=>null);
          await user?.send('Başvurun reddedildi. Katılımın için teşekkür ederiz.').catch(()=>null);
        }
        await interaction.update({content:`Başvuru ${app.status==='accepted'?'kabul edildi':'reddedildi'}.`,components:[]});
        return;
      }
      if(id.startsWith('poll:')){
        const [,pollId,indexText]=id.split(':'); const poll=await Poll.findById(pollId);
        if(!poll) return interaction.reply({content:'Anket bulunamadı.',ephemeral:true});
        if(poll.votes[interaction.user.id]!==undefined) return interaction.reply({content:'Bu ankette zaten oy kullandın.',ephemeral:true});
        const index=Number(indexText); if(!Number.isInteger(index)||index<0||index>=poll.options.length) return interaction.reply({content:'Geçersiz seçenek.',ephemeral:true});
        poll.votes[interaction.user.id]=index; poll.markModified('votes'); await poll.save();
        const counts=poll.options.map((_,i)=>Object.values(poll.votes).filter(v=>v===i).length);
        const row=new ActionRowBuilder().addComponents(poll.options.map((x,i)=>new ButtonBuilder().setCustomId(`poll:${poll._id}:${i}`).setLabel(`${i+1}. ${x.slice(0,45)} (${counts[i]})`).setStyle(ButtonStyle.Primary).setDisabled(true)));
        // Oy kullanan tekil kullanıcıyı korumak için tüm butonlar kapatılmaz; mesajdaki toplamlar güncellenir.
        const activeRow=new ActionRowBuilder().addComponents(poll.options.map((x,i)=>new ButtonBuilder().setCustomId(`poll:${poll._id}:${i}`).setLabel(`${i+1}. ${x.slice(0,45)} (${counts[i]})`).setStyle(ButtonStyle.Primary)));
        await interaction.message.edit({components:[activeRow]});
        return interaction.reply({content:`Oy kaydedildi: **${poll.options[index]}**`,ephemeral:true});
      }
      if(id.startsWith('giveaway_join')){
        const msgId=interaction.message.id;
        const g=await Giveaway.findOne({messageId:msgId,ended:false});
        if(!g) return interaction.reply({content:'Bu çekiliş sona ermiş.',ephemeral:true});
        if(g.entrants.includes(interaction.user.id)) return interaction.reply({content:'Zaten katılmışsın.',ephemeral:true});
        g.entrants.push(interaction.user.id); await g.save();
        return interaction.reply({content:'🎉 Çekilişe katıldın!',ephemeral:true});
      }
      if(id.startsWith('drop_claim:')){
        const dropId=id.split(':')[1]; const d=await Drop.findById(dropId);
        if(!d||d.ended) return interaction.reply({content:'Bu drop daha önce kazanılmış.',ephemeral:true});
        await finishDrop(dropId,interaction.user.id);
        return interaction.reply({content:'🎁 Drop senin oldu!',ephemeral:true});
      }
      if(id.startsWith('suggest_up:')||id.startsWith('suggest_down:')){
        const [kind,sid]=id.split(':'); const s=await Suggestion.findById(sid);
        if(!s) return interaction.reply({content:'Öneri bulunamadı.',ephemeral:true});
        if(s.up.includes(interaction.user.id)||s.down.includes(interaction.user.id)) return interaction.reply({content:'Bu öneriye zaten oy verdin. Oyunu değiştiremezsin.',ephemeral:true});
        if(kind==='suggest_up') s.up.push(interaction.user.id); else s.down.push(interaction.user.id);
        await s.save();
        const row=new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`suggest_up:${sid}`).setLabel(`Olumlu ${s.up.length}`).setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`suggest_down:${sid}`).setLabel(`Olumsuz ${s.down.length}`).setStyle(ButtonStyle.Danger)
        );
        await interaction.message.edit({components:[row]});
        return interaction.reply({content:'Oyun kaydedildi.',ephemeral:true});
      }
      if(id.startsWith('ticket_')){
        const ticket=await Ticket.findOne({channelId:interaction.channelId,status:'open'});
        if(!ticket) return interaction.reply({content:'Açık ticket kaydı bulunamadı.',ephemeral:true});
        if(id==='ticket_claim'){
          if(!await isTicketStaff(interaction.member)) return interaction.reply({content:'Bu işlem yetkililere açık.',ephemeral:true});
          if(ticket.claimedBy&&ticket.claimedBy!==interaction.user.id) return interaction.reply({content:`Bu ticket <@${ticket.claimedBy}> tarafından sahiplenilmiş.`,ephemeral:true});
          ticket.claimedBy=interaction.user.id; ticket.helpers=[]; await ticket.save();
          await interaction.channel.permissionOverwrites.edit(ticket.ownerId,{ViewChannel:true,SendMessages:true,ReadMessageHistory:true});
          const cfg=await configFor(interaction.guildId);
          for(const roleId of cfg.ticketSupportRoleIds){
            await interaction.channel.permissionOverwrites.edit(roleId,{ViewChannel:true,SendMessages:false,ReadMessageHistory:true}).catch(()=>null);
          }
          await interaction.channel.permissionOverwrites.edit(interaction.user.id,{ViewChannel:true,SendMessages:true,ReadMessageHistory:true});
          return interaction.reply({content:`Ticket <@${interaction.user.id}> tarafından sahiplenildi. Diğer yetkililerin yazma izni kapatıldı.`});
        }
        if(id==='ticket_help'){
          if(!await isTicketStaff(interaction.member)) return interaction.reply({content:'Bu işlem yetkililere açık.',ephemeral:true});
          if(ticket.claimedBy!==interaction.user.id) return interaction.reply({content:'Yalnızca ticket sahibi yetkili yardım isteyebilir.',ephemeral:true});
          ticket.helpers.push(interaction.user.id); ticket.claimedBy=null; await ticket.save();
          const cfg=await configFor(interaction.guildId);
          for(const roleId of cfg.ticketSupportRoleIds) await interaction.channel.permissionOverwrites.edit(roleId,{ViewChannel:true,SendMessages:true,ReadMessageHistory:true}).catch(()=>null);
          return interaction.reply({content:'🆘 Yetkili yardımı açıldı. Diğer yetkililer tekrar yazabilir.'});
        }
        if(id==='ticket_close'){
          if(!await isTicketStaff(interaction.member)) return interaction.reply({content:'Ticket kapatma yetkin yok.',ephemeral:true});
          const owner=await interaction.guild.members.fetch(ticket.ownerId).catch(()=>null);
          if(owner) await owner.send(`Ticketin kapatıldı: ${interaction.guild.name}`).catch(()=>null);
          await interaction.channel.permissionOverwrites.edit(ticket.ownerId,{ViewChannel:false,SendMessages:false}).catch(()=>null);
          const cfg=await configFor(interaction.guildId);
          for(const roleId of cfg.ticketSupportRoleIds) await interaction.channel.permissionOverwrites.edit(roleId,{ViewChannel:true,SendMessages:true,ReadMessageHistory:true}).catch(()=>null);
          ticket.status='closed'; ticket.closedAt=new Date(); await ticket.save();
          const msgs=await interaction.channel.messages.fetch({limit:100});
          const transcript=[...msgs.values()].reverse().map(m=>`[${m.createdAt.toISOString()}] ${m.author.tag}: ${m.content}`).join('\n').slice(0,180000);
          const file=Buffer.from(transcript||'Mesaj bulunamadı.','utf8');
          const logCh=cfg.logChannelId?await interaction.guild.channels.fetch(cfg.logChannelId).catch(()=>null):null;
          if(logCh?.isTextBased()) await logCh.send({content:`🎫 Ticket transcript | Sahip: <@${ticket.ownerId}> | Kategori: ${ticket.category}`,files:[{attachment:file,name:`transcript-${ticket.channelId}.txt`}]});
          return interaction.reply({content:'Ticket kapatıldı. Kanal silinmedi; transcript log kanalına gönderildi.'});
        }
        if(id==='ticket_transfer'){
          if(!await isTicketStaff(interaction.member)) return interaction.reply({content:'Bu işlem yetkililere açık.',ephemeral:true});
          const modal=new ModalBuilder().setCustomId(`ticket_transfer_modal:${ticket._id}`).setTitle('Ticket devret');
          modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('user').setLabel('Devredilecek yetkilinin kullanıcı ID’si').setStyle(TextInputStyle.Short).setRequired(true)));
          return interaction.showModal(modal);
        }
      }
      if(id.startsWith('tkm_accept:')||id.startsWith('tkm_decline:')){
        const [action,gameId]=id.split(':'); const game=await Tkm.findById(gameId);
        if(!game||game.status!=='pending') return interaction.reply({content:'Oyun artık geçerli değil.',ephemeral:true});
        if(interaction.user.id!==game.opponentId) return interaction.reply({content:'Bu davet sana gönderilmedi.',ephemeral:true});
        if(action==='tkm_decline'){game.status='declined';await game.save();return interaction.update({content:'Oyun reddedildi.',components:[]});}
        game.status='playing'; await game.save();
        const row=new ActionRowBuilder().addComponents(['taş','kağıt','makas'].map(x=>new ButtonBuilder().setCustomId(`tkm_choice:${gameId}:${x}`).setLabel(x).setStyle(ButtonStyle.Primary)));
        return interaction.update({content:`<@${game.challengerId}> ve <@${game.opponentId}>, seçiminizi yapın.`,components:[row]});
      }
      if(id.startsWith('tkm_choice:')){
        const [,gameId,choice]=id.split(':'); const game=await Tkm.findById(gameId);
        if(!game||game.status!=='playing') return interaction.reply({content:'Oyun bulunamadı.',ephemeral:true});
        if(![game.challengerId,game.opponentId].includes(interaction.user.id)) return interaction.reply({content:'Bu oyunun oyuncusu değilsin.',ephemeral:true});
        if(game.choices[interaction.user.id]) return interaction.reply({content:'Seçimini zaten yaptın.',ephemeral:true});
        game.choices[interaction.user.id]=choice; game.markModified('choices'); await game.save();
        if(!game.choices[game.challengerId]||!game.choices[game.opponentId]) return interaction.reply({content:'Seçimin kaydedildi. Diğer oyuncu bekleniyor.',ephemeral:true});
        const a=game.choices[game.challengerId],b=game.choices[game.opponentId];
        const wins={taş:'makas',makas:'kağıt',kağıt:'taş'};
        const winner=a===b?null:(wins[a]===b?game.challengerId:game.opponentId);
        game.status='finished';await game.save();
        await interaction.update({content:`${winner?`🏆 <@${winner}> kazandı!`:'🤝 Berabere!'}\n<@${game.challengerId}>: **${a}**\n<@${game.opponentId}>: **${b}**`,components:[]});
        return;
      }
    }

    if(interaction.isModalSubmit()){
      if(interaction.customId.startsWith('application_modal:')){
        const guildId=interaction.customId.split(':')[1]; const cfg=await configFor(guildId);
        const answers=cfg.applicationQuestions.slice(0,5).map((_,i)=>interaction.fields.getTextInputValue(`q${i}`));
        const app=await Application.create({guildId,userId:interaction.user.id,answers});
        const sent=await sendApplicationDM(app).catch(()=>false);
        if(!sent) return interaction.reply({content:'Kurucunun DM gönderimi başarısız oldu. Lütfen daha sonra tekrar dene.',ephemeral:true});
        return interaction.reply({content:'Başvurun kurucuya gönderildi. Sonuç DM üzerinden bildirilecek.',ephemeral:true});
      }
      if(interaction.customId.startsWith('ticket_transfer_modal:')){
        const ticketId=interaction.customId.split(':')[1]; const ticket=await Ticket.findById(ticketId);
        if(!ticket||ticket.status!=='open') return interaction.reply({content:'Ticket bulunamadı.',ephemeral:true});
        if(ticket.claimedBy!==interaction.user.id) return interaction.reply({content:'Yalnızca sahiplenen yetkili devredebilir.',ephemeral:true});
        const targetId=interaction.fields.getTextInputValue('user').trim();
        const target=await interaction.guild.members.fetch(targetId).catch(()=>null);
        if(!target||!await isTicketStaff(target)) return interaction.reply({content:'Belirtilen kullanıcı sunucuda yetkili değil.',ephemeral:true});
        ticket.claimedBy=target.id; await ticket.save();
        await interaction.channel.permissionOverwrites.edit(interaction.user.id,{ViewChannel:true,SendMessages:false}).catch(()=>null);
        await interaction.channel.permissionOverwrites.edit(target.id,{ViewChannel:true,SendMessages:true,ReadMessageHistory:true});
        return interaction.reply({content:`Ticket <@${target.id}> kullanıcısına devredildi.`});
      }
    }
  } catch(e) {
    console.error('Interaction hatası:',e);
    if(interaction.isRepliable()&&!interaction.replied&&!interaction.deferred) await interaction.reply({content:'İşlem sırasında hata oluştu.',ephemeral:true}).catch(()=>null);
  }
});

(async()=>{
  try{
    await initDatabase();
    console.log('JSON veritabanı hazır.');
    await client.login(process.env.DISCORD_TOKEN);
  }catch(e){console.error('Başlatma hatası:',e);process.exit(1);}
})();
