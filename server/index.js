// index.js
require('dotenv').config();
const { Client, GatewayIntentBits, Collection, REST, Routes, SlashCommandBuilder } = require('discord.js');
const { ensureUser, addBalance, getBalance, addItem, getInventory, removeItem } = require('./database');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const COOLDOWN = 20; // segundos
const cooldowns = new Map(); // userId -> timestamp last mine

// itens e preços de venda (exemplo)
const ITEMS = {
  stone: { name: 'Pedra', price: 5 },
  iron: { name: 'Ferro', price: 20 },
  gold: { name: 'Ouro', price: 60 },
  diamond: { name: 'Diamante', price: 200 },
  emerald: { name: 'Esmeralda', price: 350 }
};

// rng rewards
function mineRoll(){
  const r = Math.random();
  if(r < 0.45) return { item: 'stone', qty: Math.floor(Math.random()*3)+1 }; // 45%
  if(r < 0.75) return { item: 'iron', qty: 1 + (Math.random() < 0.2 ? 1 : 0) }; // 30%
  if(r < 0.9) return { item: 'gold', qty: 1 }; // 15%
  if(r < 0.97) return { item: 'diamond', qty: 1 }; // 7%
  return { item: 'emerald', qty: 1 }; // 3%
}

// registra comandos slash (guild-scoped durante dev; para global remove guild id)
async function registerCommands(){
  const commands = [
    new SlashCommandBuilder().setName('mine').setDescription('Cava/mina e consegue recursos.'),
    new SlashCommandBuilder().setName('inv').setDescription('Mostra seu inventário.'),
    new SlashCommandBuilder().setName('bal').setDescription('Mostra seu saldo.'),
    new SlashCommandBuilder()
      .setName('shop')
      .setDescription('Mostra itens vendáveis e preços.'),
    new SlashCommandBuilder()
      .setName('sell')
      .setDescription('Vende um item do inventário.')
      .addStringOption(opt => opt.setName('item').setDescription('item para vender').setRequired(true))
      .addIntegerOption(opt => opt.setName('qty').setDescription('quantidade').setRequired(true))
  ].map(c => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
  if(!process.env.GUILD_ID || !process.env.CLIENT_ID) {
    console.warn('GUILD_ID ou CLIENT_ID não configurados — registrando globalmente (pode demorar).');
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
  } else {
    await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
  }
  console.log('Comandos registrados.');
}

client.once('ready', async () => {
  console.log(`Logado como ${client.user.tag}`);
  try { await registerCommands(); } catch(e){ console.error('Erro registrando comandos:',e); }
});

client.on('interactionCreate', async (interaction) => {
  if(!interaction.isChatInputCommand()) return;

  const userId = interaction.user.id;
  const name = interaction.commandName;

  await ensureUser(userId);

  if(name === 'mine'){
    // cooldown
    const last = cooldowns.get(userId) || 0;
    const now = Date.now();
    const diff = (now - last)/1000;
    if(diff < COOLDOWN){
      return interaction.reply({ content: `Calma aí mano, espera mais ${Math.ceil(COOLDOWN - diff)}s antes de minerar de novo.`, ephemeral: true });
    }
    cooldowns.set(userId, now);

    // rolar recompensa
    const reward = mineRoll();
    await addItem(userId, reward.item, reward.qty);
    const human = `${reward.qty}x ${ITEMS[reward.item].name}`;
    return interaction.reply({ content: `⛏️ Você minerou: **${human}**! Muito brabo.` });
  }

  if(name === 'inv'){
    const inv = await getInventory(userId);
    if(inv.length === 0) return interaction.reply('Seu inventário tá vazio. Vai minerar aí! ⛏️');
    const lines = inv.map(i => `${ITEMS[i.item]?.name || i.item}: ${i.qty}`);
    return interaction.reply({ content: `📦 Seu inventário:\n${lines.join('\n')}` });
  }

  if(name === 'bal'){
    const bal = await getBalance(userId);
    return interaction.reply({ content: `💰 Seu saldo: **${bal} coins**` });
  }

  if(name === 'shop'){
    const lines = Object.entries(ITEMS).map(([k,v]) => `${v.name} (${k}): vende por ${v.price} coins`);
    return interaction.reply({ content: `🛒 Loja (preços de venda):\n${lines.join('\n')}` });
  }

  if(name === 'sell'){
    const item = interaction.options.getString('item').toLowerCase();
    const qty = interaction.options.getInteger('qty');
    if(!ITEMS[item]) return interaction.reply({ content: 'Item inválido. Use /shop para ver os itens.', ephemeral: true });
    try {
      await removeItem(userId, item, qty);
    } catch(e){
      return interaction.reply({ content: 'Você não tem essa quantidade desse item.', ephemeral: true });
    }
    const gained = ITEMS[item].price * qty;
    await addBalance(userId, gained);
    return interaction.reply({ content: `Você vendeu ${qty}x ${ITEMS[item].name} por **${gained} coins**.` });
  }
});

// tratamento simples de mensagens (opcional)
client.on('messageCreate', msg => {
  if(msg.author.bot) return;
  // exemplo: resposta rápida ao dizer "mina"
  if(msg.content.toLowerCase() === 'mina'){
    msg.reply('Use /mine pra minerar 😉');
  }
});

client.login(process.env.BOT_TOKEN);