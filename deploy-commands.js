require('dotenv').config();
const { REST, Routes } = require('discord.js');
const commands = require('./src/slash');
(async()=>{
  const rest=new REST({version:'10'}).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(process.env.CLIENT_ID),{body:commands});
  console.log('Slash komutları yüklendi.');
})().catch(console.error);
