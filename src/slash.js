const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const commands = [
  new SlashCommandBuilder().setName('setup').setDescription('WYX kurulum panelini açar'),
  new SlashCommandBuilder().setName('log').setDescription('Log kanalını ayarlar')
    .addChannelOption(o => o.setName('kanal').setDescription('Log kanalı').addChannelTypes(ChannelType.GuildText).setRequired(true)),
  new SlashCommandBuilder().setName('anket').setDescription('Anket oluşturur')
    .addStringOption(o => o.setName('soru').setDescription('Anket sorusu').setRequired(true))
    .addStringOption(o => o.setName('secenekler').setDescription('Seçenekleri | ile ayır (2-6)').setRequired(true)),
  new SlashCommandBuilder().setName('yetkili-basvuru').setDescription('Yetkili başvuru panelini gönderir'),
  new SlashCommandBuilder().setName('ticketpanel').setDescription('Ticket panelini gönderir'),
  new SlashCommandBuilder().setName('ticket-yetkili').setDescription('Ticket yetkili rolünü ayarlar')
    .addRoleOption(o => o.setName('rol').setDescription('Ticket destek rolü').setRequired(true)),
  new SlashCommandBuilder().setName('basvuru-ayarla').setDescription('Başvuru sorularını ve kabul rolünü ayarlar')
    .addStringOption(o => o.setName('sorular').setDescription('Her satıra bir soru yaz; en fazla 10 soru').setRequired(true))
    .addRoleOption(o => o.setName('rol').setDescription('Kabul edilene verilecek rol').setRequired(true)),
  new SlashCommandBuilder().setName('xp').setDescription('XP rol eşiğini ayarlar')
    .addIntegerOption(o => o.setName('xp').setDescription('XP eşiği').setRequired(true))
    .addRoleOption(o => o.setName('rol').setDescription('Verilecek rol').setRequired(true)),
  new SlashCommandBuilder().setName('dogumgunu').setDescription('Discord hesap yıl dönümü ödülüne kaydolur'),
  new SlashCommandBuilder().setName('yardim').setDescription('Komut listesini gösterir')
].map(c => c.toJSON());
module.exports = commands;
