const { Markup } = require('telegraf');
const axios = require('axios');
const QRCode = require('qrcode');

// Validate token with Relay
async function validateToken(symbol, network, db) {
  try {
    const response = await axios.post('https://api.relay.link/currencies/v1', {
      defaultList: true,
      chainIds: [Number(network)],
      term: symbol.toUpperCase(),
      verified: true,
      limit: 1
    });
    const token = response.data[0]?.[0];
    if (!token) throw new Error('Token not found');
    return {
      chainId: token.chainId,
      address: token.address,
      symbol: token.symbol,
      name: token.name,
      decimals: token.decimals
    };
  } catch (error) {
    console.error('Validation Error:', error.message);
    throw error;
  }
}

// Create Blockradar wallet
async function createBlockradarWallet(userId, bankDetails, db) {
  const response = await axios.post('https://api.blockradar.co/wallets', {
    chain: 'base', // Still Base for receiving USDC, adjust if needed
    externalId: `${userId}-${Date.now()}`
  }, {
    headers: {
      'Authorization': `Bearer ${process.env.BLOCKRADAR_API_KEY}`,
      'Content-Type': 'application/json'
    }
  });
  const wallet = response.data;
  await db.collection('wallets').doc(wallet.id).set({
    userId,
    bankDetails,
    address: wallet.address,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  return wallet.address;
}

// Connect wallet
async function connectWallet(ctx, userId, bankDetails, db) {
  try {
    const blockradarWallet = await createBlockradarWallet(userId, bankDetails, db);
    ctx.session.blockradarWallet = blockradarWallet;

    const connectUrl = `${process.env.WEBAPP_URL}/connect?userId=${userId}&session=${Date.now()}`;
    const qrBuffer = await QRCode.toBuffer(connectUrl, { width: 300 });

    await ctx.editMessageText(
      'Connect your wallet to approve and deposit:',
      {
        message_id: ctx.session.sellMessageId,
        reply_markup: {
          inline_keyboard: [[Markup.button.url('Connect', connectUrl)]]
        }
      }
    );
    await ctx.replyWithPhoto({ source: qrBuffer });
  } catch (error) {
    console.error('Connect Error:', error.message);
    await ctx.editMessageText('❌ Error connecting wallet. Try again.');
  }
}

// Sell scene
module.exports = (bot, db) => {
  bot.command('sell', async (ctx) => {
    const [_, amount, symbol, network] = ctx.message.text.toLowerCase().split(' ');
    if (!amount || !symbol || !network || isNaN(amount)) {
      return ctx.reply('Usage: /sell <amount> <symbol> <network>\nExample: /sell 10 usdc base');
    }

    try {
      const token = await validateToken(symbol, network, db);
      ctx.session = { amount, token };

      const message = `
        **Sell Confirmation**
        You want to sell ${amount} ${token.symbol} on chain ${token.chainId}.
        Proceed?
      `;
      const sentMessage = await ctx.reply(message, {
        reply_markup: {
          inline_keyboard: [
            [Markup.button.callback('Yes', 'confirm_sell')],
            [Markup.button.callback('No', 'cancel_sell')]
          ]
        }
      });
      ctx.session.sellMessageId = sentMessage.message_id;
    } catch (error) {
      ctx.reply('❌ Token not found on this network. Try again.');
    }
  });

  bot.action('confirm_sell', async (ctx) => {
    try {
      const userId = ctx.from.id.toString();
      const userDoc = await db.collection('users').doc(userId).get();
      const linkedBank = userDoc.exists ? userDoc.data().bankDetails : null;

      await ctx.editMessageText(
        linkedBank ? 'Use your linked bank or a new one?' : 'Link a bank account to proceed.',
        {
          message_id: ctx.session.sellMessageId,
          reply_markup: {
            inline_keyboard: linkedBank
              ? [
                  [Markup.button.callback('Linked Bank', 'use_linked_bank')],
                  [Markup.button.callback('New Bank', 'link_new_bank')]
                ]
              : [[Markup.button.callback('New Bank', 'link_new_bank')]]
          }
        }
      );
    } catch (error) {
      console.error('Confirm Sell Error:', error.message);
      await ctx.editMessageText('❌ Error processing confirmation.');
    }
  });

  bot.action('use_linked_bank', async (ctx) => {
    try {
      const userId = ctx.from.id.toString();
      const userDoc = await db.collection('users').doc(userId).get();
      const bankDetails = userDoc.data().bankDetails;
      await connectWallet(ctx, userId, bankDetails, db);
    } catch (error) {
      console.error('Use Linked Bank Error:', error.message);
      await ctx.editMessageText('❌ Error using linked bank.');
    }
  });

  bot.action('link_new_bank', async (ctx) => {
    ctx.session.bankLinking = true;
    await ctx.editMessageText(
      'Enter bank details (e.g., "Name, Number, Bank"):',
      { message_id: ctx.session.sellMessageId }
    );
  });

  bot.on('text', async (ctx) => {
    if (ctx.session?.bankLinking) {
      const [name, number, bank] = ctx.message.text.split(', ').map(s => s.trim());
      if (!name || !number || !bank) {
        return ctx.reply('Invalid format. Use: "Name, Number, Bank"');
      }
      const bankDetails = { accountName: name, accountNumber: number, bankName: bank };
      ctx.session.bankLinking = false;
      await connectWallet(ctx, ctx.from.id.toString(), bankDetails, db);
    }
  });

  bot.action('cancel_sell', async (ctx) => {
    await ctx.editMessageText(
      'Cancelled. Retry?',
      {
        message_id: ctx.session.sellMessageId,
        reply_markup: {
          inline_keyboard: [[Markup.button.callback('Retry', 'retry_sell')]]
        }
      }
    );
  });

  bot.action('retry_sell', (ctx) => ctx.reply('Use /sell <amount> <symbol> <network>'));
};
