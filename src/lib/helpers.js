const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { GuildConfig, UserStats } = require('../models');

async function configFor(guildId) {
  let cfg = await GuildConfig.findOne({ guildId });
  if (!cfg) cfg = await GuildConfig.create({ guildId });
  return cfg;
}
async function log(guild, text, color = 0x7C3AED) {
  try {
    const cfg = await configFor(guild.id);
    if (!cfg.logChannelId) return;
    const ch = await guild.channels.fetch(cfg.logChannelId).catch(() => null);
    if (!ch?.isTextBased()) return;
    const embed = new EmbedBuilder().setColor(color).setDescription(text).setTimestamp();
    await ch.send({ embeds: [embed] });
  } catch (e) { console.error('Log hatası:', e.message); }
}
function can(member, permission) { return !!member?.permissions?.has(permission); }
function admin(member) { return can(member, PermissionFlagsBits.Administrator); }
function parseTime(value) {
  const m = /^(\d+)(s|m|h|d)$/.exec(value || '');
  if (!m) return null;
  return Number(m[1]) * ({ s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2]]);
}
function levelForXp(xp) {
  let level = 0;
  while (xp >= 100 * (level + 1) + 25 * level * (level + 1)) level++;
  return level;
}
async function addXp(guild, userId, amount, channel = null) {
  let stats = await UserStats.findOne({ guildId: guild.id, userId });
  if (!stats) stats = await UserStats.create({ guildId: guild.id, userId });
  const oldLevel = stats.level;
  stats.totalXp += amount;
  stats.weeklyXp += amount;
  stats.level = levelForXp(stats.totalXp);
  await stats.save();

  const cfg = await configFor(guild.id);
  for (const rule of [...(cfg.xpRoleRules || [])].sort((a,b) => a.xp-b.xp)) {
    if (stats.totalXp >= rule.xp) {
      const member = await guild.members.fetch(userId).catch(() => null);
      const role = await guild.roles.fetch(rule.roleId).catch(() => null);
      if (member && role && role.editable && !member.roles.cache.has(role.id)) {
        await member.roles.add(role).catch(() => null);
      }
    }
  }
  if (stats.level > oldLevel && stats.level % 5 === 0 && channel?.isTextBased()) {
    await channel.send(`🎉 <@${userId}> tebrikler! **${stats.level}. seviyeye** ulaştın!`).catch(() => null);
  }
  return stats;
}
module.exports = { configFor, log, can, admin, parseTime, levelForXp, addXp };
