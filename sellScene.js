const { Scenes, Markup } = require('telegraf');
const axios = require('axios');
const admin = require('firebase-admin');

// Initialize Firebase (assuming bot.js sets this up globally)
const db = admin.firestore();

// Logger setup
const winston = require('winston');
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `[${timestamp}] ${level.toUpperCase()}: ${message}`)
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'bot.log', maxsize: 5242880, maxFiles: 5 }),
  ],
});

// Simplified getUserState
async function getUserState(userId) {
  try {
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      const defaultState = { wallets: [], bankDetails: null, usePidgin: false };
      await db.collection('users').doc(userId).set(defaultState);
      logger.info(`Initialized user state for ${userId}`);
      return defaultState;
    }
    const data = userDoc.data();
    return {
      wallets: data.wallets || [],
      bankDetails: data.bankDetails || null,
      usePidgin: data.usePidgin || false,
    };
  } catch (error) {
    logger.error(`Failed to fetch user state for ${userId}: ${error.message}`);
    return { wallets: [], bankDetails: null, usePidgin: false };
  }
}

const networkMap = {
  'base': 8453,
  'polygon': 137,
  'bnb': 56,
  'ethereum': 1,
};

const chains = {
  base: { chainId: 8453, name: 'Base' },
  polygon: { chainId: 137, name: 'Polygon' },
  bnb: { chainId: 56, name: 'BNB Chain' },
  ethereum: { chainId: 1, name: 'Ethereum' },
};

// Sell Scene
const sellScene = new Scenes.WizardScene(
  'sell_scene',
  // Step 1: Validate /sell input and token
  async (ctx) => {
    const userId = ctx.from.id.toString();
    logger.info(`User ${userId} entered sell_scene with: ${ctx.message.text}`);

    // Stricter command check to avoid misinterpreting "Yes" as a command
    if (!ctx.message.text.startsWith('/sell ')) {
      await ctx.reply('Use: /sell <amount> <currency or address> <network>');
      return ctx.scene.leave();
    }

    const args = ctx.message.text.split(' ').filter(arg => arg.trim() !== '');
    if (args.length !== 4) {
      const userState = await getUserState(userId);
      const usage = userState.usePidgin
        ? 'Usage: /sell <amount> <currency or address> <network>\nE.g., /sell 10 USDC base or /sell 10 0x833589f... base'
        : 'Usage: /sell <amount> <currency or address> <network>\nExample: /sell 10 USDC base or /sell 10 0x833589f... base';
      await ctx.replyWithMarkdown(usage);
      return ctx.scene.leave();
    }

    const [, amountStr, caOrTerm, network] = args;
    const amount = parseFloat(amountStr);
    const userState = await getUserState(userId);

    if (!amount || isNaN(amount) || amount <= 0) {
      await ctx.replyWithMarkdown(userState.usePidgin ? '❌ Amount no correct. Use number wey big pass 0.' : '❌ Invalid amount. Please use a positive number.');
      return ctx.scene.leave();
    }

    const chainId = networkMap[network.toLowerCase()];
    if (!chainId || !Object.values(chains).some(c => c.chainId === chainId)) {
      const error = userState.usePidgin
        ? 'Network no dey o. We support: base, polygon, bnb, ethereum'
        : 'Invalid network. Supported: base, polygon, bnb, ethereum';
      await ctx.replyWithMarkdown(error);
      return ctx.scene.leave();
    }

    const isAddress = /^0x[a-fA-F0-9]{40}$/.test(caOrTerm);
    const payload = isAddress
      ? { chainIds: [chainId], address: caOrTerm.toLowerCase(), verified: true, limit: 123, includeAllChains: true, useExternalSearch: true, depositAddressOnly: true }
      : { chainIds: [chainId], term: caOrTerm.toLowerCase(), verified: true, limit: 123, includeAllChains: true, useExternalSearch: true, depositAddressOnly: true };

    let currencyRes;
    try {
      currencyRes = await axios.post('https://api.relay.link/currencies/v1', payload, { timeout: 5000 });
      logger.info(`Relay API response for user ${userId}: ${JSON.stringify(currencyRes.data)}`);
    } catch (err) {
      logger.error(`Relay currency validation failed for ${caOrTerm} on ${network}: ${err.message}`);
      await ctx.replyWithMarkdown(userState.usePidgin ? '❌ Wahala dey o. Currency or address check fail. Try again.' : '❌ Error validating currency or address. Please try again.');
      return ctx.scene.leave();
    }

    if (!currencyRes.data[0]?.length || currencyRes.data[0][0].chainId !== chainId) {
      const error = userState.usePidgin
        ? `❌ ${caOrTerm} no dey for ${network}. Check am well o.`
        : `❌ ${caOrTerm} not found or invalid on ${network}. Please check your input.`;
      await ctx.replyWithMarkdown(error);
      return ctx.scene.leave();
    }

    const currencyData = currencyRes.data[0][0];
    const decimals = currencyData.decimals;
    const amountInWei = (amount * Math.pow(10, decimals)).toString();
    ctx.wizard.state = {
      userId,
      amount,
      amountInWei,
      ca: currencyData.symbol,
      chainId,
      originCurrency: currencyData.address,
      decimals,
      network: network.toLowerCase(),
    };
    logger.info(`User ${userId} set wizard state: ${JSON.stringify(ctx.wizard.state)}`);

    const confirm = userState.usePidgin
      ? `You wan sell ${amount} ${currencyData.symbol} on ${network}?\nPress "Yes" to go ahead, "No" to stop.`
      : `Sell ${amount} ${currencyData.symbol} on ${network}?\nReply "Yes" to confirm, "No" to cancel.`;
    try {
      await ctx.replyWithMarkdown(confirm, Markup.inlineKeyboard([
        Markup.button.callback('✅ Yes', 'yes'),
        Markup.button.callback('❌ No', 'no'),
      ]));
      logger.info(`User ${userId} prompted for confirmation`);
      logger.info(`Current wizard step before next: ${ctx.wizard.cursor}`);
      return ctx.wizard.next();
    } catch (error) {
      logger.error(`Failed to send confirmation message for user ${userId}: ${error.message}`);
      await ctx.reply('Error sending confirmation. Try again.');
      return ctx.scene.leave();
    }
  },
  // Step 2: Bank Selection
  async (ctx) => {
    logger.info(`User ${ctx.from.id} at step 2, wizard state: ${JSON.stringify(ctx.wizard.state)}`);
    logger.info(`Current wizard step: ${ctx.wizard.cursor}`);

    if (!ctx.callbackQuery) {
      logger.warn(`No callbackQuery for user ${ctx.from.id} in step 2`);
      await ctx.reply('Please confirm or cancel the token selection.');
      return ctx.scene.leave();
    }

    const action = ctx.callbackQuery.data;
    if (action === 'no') {
      await ctx.reply('Sell cancelled.');
      await ctx.answerCbQuery();
      return ctx.scene.leave();
    }

    if (action !== 'yes') {
      logger.warn(`Unexpected callback ${action} for user ${ctx.from.id}`);
      await ctx.reply('Unexpected action. Use /sell to start over.');
      await ctx.answerCbQuery();
      return ctx.scene.leave();
    }

    const userId = ctx.wizard.state.userId;
    const userState = await getUserState(userId);
    const linkedBank = userState.bankDetails;
    const prompt = linkedBank
      ? (userState.usePidgin
          ? `Step 2/3: Use your linked bank (${linkedBank.bankName} - ****${linkedBank.accountNumber.slice(-4)}) or add new one?`
          : `Step 2/3: Use your linked bank (${linkedBank.bankName} - ****${linkedBank.accountNumber.slice(-4)}) or add a new one?`)
      : (userState.usePidgin
          ? 'Step 2/3: You no get bank linked o. Add one now?'
          : 'Step 2/3: No linked bank found. Add one now?');

    const buttons = linkedBank
      ? [
          [Markup.button.callback(`✅ Use ${linkedBank.bankName}`, 'use_bank')],
          [Markup.button.callback('🏦 Add New Bank', 'new_bank')],
          [Markup.button.callback('❌ Cancel', 'cancel_sell')],
        ]
      : [
          [Markup.button.callback('🏦 Add New Bank', 'new_bank')],
          [Markup.button.callback('❌ Cancel', 'cancel_sell')],
        ];

    try {
      await ctx.reply(prompt, Markup.inlineKeyboard(buttons));
      await ctx.answerCbQuery();
      logger.info(`User ${userId} shown bank options`);
      return ctx.wizard.next();
    } catch (error) {
      logger.error(`Failed to send bank options for user ${userId}: ${error.message}`);
      await ctx.reply('Error showing bank options. Try again.');
      return ctx.scene.leave();
    }
  },
  // Step 3: Wallet Connection
  async (ctx) => {
    logger.info(`User ${ctx.from.id} at step 3, wizard state: ${JSON.stringify(ctx.wizard.state)}`);
    logger.info(`Current wizard step: ${ctx.wizard.cursor}`);

    if (!ctx.callbackQuery) {
      logger.warn(`No callbackQuery for user ${ctx.from.id} in step 3`);
      await ctx.reply('Please select a bank option.');
      return ctx.scene.leave();
    }

    const userId = ctx.wizard.state.userId;
    const userState = await getUserState(userId);

    if (ctx.callbackQuery.data === 'cancel_sell') {
      await ctx.reply('Sell cancelled.');
      await ctx.answerCbQuery();
      return ctx.scene.leave();
    } else if (ctx.callbackQuery.data === 'new_bank') {
      logger.info(`User ${userId} chose new bank`);
      await ctx.answerCbQuery();
      return ctx.scene.enter('bank_linking_scene_temp', { sellData: ctx.wizard.state });
    } else if (ctx.callbackQuery.data === 'use_bank') {
      logger.info(`User ${userId} chose existing bank`);
      ctx.wizard.state.bankDetails = userState.bankDetails;
    } else {
      logger.warn(`Unexpected callback ${ctx.callbackQuery.data} for user ${userId}`);
      await ctx.reply('Unexpected action. Use /sell to start over.');
      await ctx.answerCbQuery();
      return ctx.scene.leave();
    }

    const sessionId = `${userId}-${Date.now()}`;
    const blockradarAddress = await generateBlockradarAddress();
    ctx.wizard.state.blockradarAddress = blockradarAddress;

    try {
      await db.collection('sessions').doc(sessionId).set({
        userId,
        amount: ctx.wizard.state.amount,
        amountInWei: ctx.wizard.state.amountInWei,
        tokenAddress: ctx.wizard.state.originCurrency,
        chainId: ctx.wizard.state.chainId,
        bankDetails: ctx.wizard.state.bankDetails,
        blockradarAddress,
        status: 'pending',
        symbol: ctx.wizard.state.ca,
        decimals: ctx.wizard.state.decimals,
        network: ctx.wizard.state.network,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (error) {
      logger.error(`Failed to save session for user ${userId}: ${error.message}`);
      await ctx.reply('Error saving session. Try again.');
      return ctx.scene.leave();
    }

    const msg = userState.usePidgin
      ? 'Step 3/3: Connect your wallet to finish.'
      : 'Step 3/3: Connect your wallet to complete the sale.';
    try {
      await ctx.reply(msg, Markup.inlineKeyboard([
        [Markup.button.url('Connect Wallet', `${process.env.WEBAPP_URL}/connect?userId=${userId}&session=${sessionId}`)],
        [Markup.button.callback('❌ Cancel', 'cancel_sell')],
      ]));
      await ctx.answerCbQuery();
      logger.info(`User ${userId} prompted to connect wallet, session: ${sessionId}`);
      return ctx.scene.leave();
    } catch (error) {
      logger.error(`Failed to prompt wallet connect for user ${userId}: ${error.message}`);
      await ctx.reply('Error connecting wallet. Try again.');
      return ctx.scene.leave();
    }
  }
);

// Handle return from bank linking
sellScene.enter(async (ctx) => {
  if (ctx.scene.state.sellData && ctx.scene.state.bankDetails) {
    const userId = ctx.from.id.toString();
    logger.info(`User ${userId} returned from bank linking`);

    ctx.wizard.state = { ...ctx.scene.state.sellData, bankDetails: ctx.scene.state.bankDetails };
    const sessionId = `${userId}-${Date.now()}`;
    const blockradarAddress = await generateBlockradarAddress();
    ctx.wizard.state.blockradarAddress = blockradarAddress;

    try {
      await db.collection('sessions').doc(sessionId).set({
        userId,
        amount: ctx.wizard.state.amount,
        amountInWei: ctx.wizard.state.amountInWei,
        tokenAddress: ctx.wizard.state.originCurrency,
        chainId: ctx.wizard.state.chainId,
        bankDetails: ctx.wizard.state.bankDetails,
        blockradarAddress,
        status: 'pending',
        symbol: ctx.wizard.state.ca,
        decimals: ctx.wizard.state.decimals,
        network: ctx.wizard.state.network,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (error) {
      logger.error(`Failed to save session after bank linking for user ${userId}: ${error.message}`);
      await ctx.reply('Error saving session. Try again.');
      return ctx.scene.leave();
    }

    const userState = await getUserState(userId);
    const msg = userState.usePidgin
      ? 'Step 3/3: Connect your wallet to finish.'
      : 'Step 3/3: Connect your wallet to complete the sale.';
    await ctx.reply(msg, Markup.inlineKeyboard([
      [Markup.button.url('Connect Wallet', `${process.env.WEBAPP_URL}/connect?userId=${userId}&session=${sessionId}`)],
      [Markup.button.callback('❌ Cancel', 'cancel_sell')],
    ]));
    logger.info(`User ${userId} prompted to connect wallet after bank linking, session: ${sessionId}`);
    return ctx.scene.leave();
  }
});

// Action Handlers
sellScene.action('yes', async (ctx) => {
  logger.info(`User ${ctx.from.id} confirmed token`);
  try {
    await ctx.answerCbQuery();
    logger.info(`User ${ctx.from.id} advancing to step 2`);
    logger.info(`Wizard step before next: ${ctx.wizard.cursor}`);
    const result = ctx.wizard.next();
    logger.info(`Wizard step after next: ${ctx.wizard.cursor}, result: ${result}`);
    return result;
  } catch (error) {
    logger.error(`Error in yes action for user ${ctx.from.id}: ${error.message}`);
    await ctx.reply('Error confirming token. Try again.');
    return ctx.scene.leave();
  }
});

sellScene.action('no', async (ctx) => {
  logger.info(`User ${ctx.from.id} cancelled sell`);
  await ctx.reply('Sell cancelled.');
  await ctx.answerCbQuery();
  return ctx.scene.leave();
});

sellScene.action('cancel_sell', async (ctx) => {
  logger.info(`User ${ctx.from.id} cancelled sell`);
  await ctx.reply('Sell cancelled.');
  await ctx.answerCbQuery();
  return ctx.scene.leave();
});

sellScene.action('use_bank', async (ctx) => {
  logger.info(`User ${ctx.from.id} selected existing bank`);
  await ctx.answerCbQuery();
  return ctx.wizard.next();
});

sellScene.action('new_bank', async (ctx) => {
  logger.info(`User ${ctx.from.id} chose new bank`);
  await ctx.answerCbQuery();
  return ctx.scene.enter('bank_linking_scene_temp', { sellData: ctx.wizard.state });
});

// Simplified Blockradar wallet generation
async function generateBlockradarAddress() {
  try {
    const response = await axios.post(
      'https://api.blockradar.co/v1/wallets/e31c44d6-0344-4ee1-bcd1-c88e89a9e3f1/addresses',
      { name: `DirectPay_Sell_${Date.now()}` },
      { headers: { 'x-api-key': process.env.BLOCKRADAR_BASE_API_KEY }, timeout: 5000 }
    );
    const address = response.data.data.address;
    logger.info(`Generated Blockradar address: ${address}`);
    return address;
  } catch (error) {
    logger.error(`Failed to generate Blockradar address: ${error.message}`);
    return '0xFallbackBlockradarAddress';
  }
}

// Export
module.exports = {
  sellScene,
  setup: () => {},
};
