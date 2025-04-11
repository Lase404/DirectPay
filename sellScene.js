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

// Sell Scene
const sellScene = new Scenes.WizardScene(
  'sell_scene',
  // Step 1: Validate /sell input and token
  async (ctx) => {
    const userId = ctx.from.id.toString();
    logger.info(`User ${userId} entered sell_scene with: ${ctx.message.text}`);

    if (!ctx.message.text.startsWith('/sell')) {
      await ctx.reply('Use: /sell <amount> <contract_address> <network>');
      return ctx.scene.leave();
    }

    const args = ctx.message.text.split(' ').filter(arg => arg.trim() !== '');
    if (args.length !== 4) {
      await ctx.reply('Invalid format. Use: /sell <amount> <contract_address> <network>\nExample: /sell 10 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 Ethereum');
      return ctx.scene.leave();
    }

    const [, amountStr, contractAddress, network] = args;
    const amount = parseFloat(amountStr);

    if (isNaN(amount) || amount <= 0) {
      await ctx.reply('Invalid amount. Please provide a positive number.');
      return ctx.scene.leave();
    }

    if (!contractAddress.startsWith('0x') || contractAddress.length !== 42) {
      await ctx.reply('Invalid contract address. It should start with 0x and be 42 characters long.');
      return ctx.scene.leave();
    }

    const chainIdMap = { 'ethereum': 1, 'base': 8453, 'solana': 101 };
    const normalizedNetwork = network.toLowerCase();
    const chainId = chainIdMap[normalizedNetwork];
    if (!chainId) {
      await ctx.reply('Supported networks: Ethereum, Base, Solana (case-insensitive).');
      return ctx.scene.leave();
    }

    let token;
    try {
      const response = await axios.post(
        'https://api.relay.link/currencies/v1',
        { chainIds: [chainId], address: contractAddress, defaultList: true, verified: true },
        { headers: { 'Content-Type': 'application/json' }, timeout: 5000 }
      );
      logger.info(`Relay API response for user ${userId}: ${JSON.stringify(response.data)}`);
      const currencies = response.data[0];
      token = currencies && currencies.length > 0 ? currencies[0] : null;
    } catch (error) {
      logger.error(`Relay API error for user ${userId}: ${error.message}`);
      if (contractAddress.toLowerCase() === '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' && chainId === 1) {
        token = { symbol: 'USDC', decimals: 6, name: 'USD Coin', address: contractAddress };
      } else {
        await ctx.reply('Failed to validate token. Try again later.');
        return ctx.scene.leave();
      }
    }

    if (!token) {
      await ctx.reply('Token not supported on this network.');
      return ctx.scene.leave();
    }

    ctx.wizard.state = {
      userId,
      amount: (amount * 10 ** token.decimals).toString(),
      tokenAddress: token.address,
      chainId,
      network: normalizedNetwork.charAt(0).toUpperCase() + normalizedNetwork.slice(1),
      symbol: token.symbol,
      decimals: token.decimals,
    };

    const userState = await getUserState(userId);
    const msg = userState.usePidgin
      ? `Step 1/3: You wan sell ${amount} ${token.symbol} (${ctx.wizard.state.network}). Correct?`
      : `Step 1/3: Sell ${amount} ${token.symbol} (${ctx.wizard.state.network}). Confirm?`;
    try {
      await ctx.reply(msg, Markup.inlineKeyboard([
        [Markup.button.callback('✅ Yes', 'confirm_token')],
        [Markup.button.callback('❌ No', 'cancel_sell')],
      ]));
      logger.info(`User ${userId} prompted for confirmation`);
      return ctx.wizard.next();
    } catch (error) {
      logger.error(`Failed to send confirmation message for user ${userId}: ${error.message}`);
      await ctx.reply('Error sending confirmation. Try again.');
      return ctx.scene.leave();
    }
  },
  // Step 2: Bank Selection
  async (ctx) => {
    const userId = ctx.wizard.state?.userId;
    if (!userId) {
      logger.error(`User ID missing in wizard state at step 2`);
      await ctx.reply('Session error. Please start over with /sell.');
      return ctx.scene.leave();
    }

    logger.info(`User ${userId} at step 2, callback: ${JSON.stringify(ctx.callbackQuery)}`);

    if (!ctx.callbackQuery) {
      logger.warn(`No callbackQuery for user ${userId} in step 2`);
      await ctx.reply('Please confirm or cancel the token selection.');
      return ctx.scene.leave();
    }

    if (ctx.callbackQuery.data === 'cancel_sell') {
      await ctx.reply('Sell cancelled.');
      await ctx.answerCbQuery();
      return ctx.scene.leave();
    }

    if (ctx.callbackQuery.data !== 'confirm_token') {
      logger.warn(`Unexpected callback ${ctx.callbackQuery.data} for user ${userId}`);
      await ctx.reply('Unexpected action. Use /sell to start over.');
      await ctx.answerCbQuery();
      return ctx.scene.leave();
    }

    const userState = await getUserState(userId);
    const bankDetails = userState.bankDetails;
    const msg = userState.usePidgin
      ? 'Step 2/3: Which bank you wan use?'
      : 'Step 2/3: Select a bank for payout:';
    const buttons = bankDetails
      ? [
          [Markup.button.callback(`✅ ${bankDetails.bankName} (****${bankDetails.accountNumber.slice(-4)})`, 'use_bank')],
          [Markup.button.callback('🏦 Add New Bank', 'new_bank')],
          [Markup.button.callback('❌ Cancel', 'cancel_sell')],
        ]
      : [
          [Markup.button.callback('🏦 Add New Bank', 'new_bank')],
          [Markup.button.callback('❌ Cancel', 'cancel_sell')],
        ];

    try {
      // Fallback to reply if editMessageText fails
      await ctx.editMessageText(msg, {
        reply_markup: Markup.inlineKeyboard(buttons).reply_markup,
        parse_mode: 'Markdown',
      });
      await ctx.answerCbQuery();
      logger.info(`User ${userId} shown bank options`);
      return ctx.wizard.next();
    } catch (error) {
      logger.error(`Failed to edit message for user ${userId}: ${error.message}`);
      try {
        await ctx.reply(msg, Markup.inlineKeyboard(buttons));
        await ctx.answerCbQuery();
        logger.info(`User ${userId} shown bank options via reply (fallback)`);
        return ctx.wizard.next();
      } catch (fallbackError) {
        logger.error(`Fallback reply failed for user ${userId}: ${fallbackError.message}`);
        await ctx.reply('Error showing bank options. Try again.');
        return ctx.scene.leave();
      }
    }
  },
  // Step 3: Wallet Connection
  async (ctx) => {
    const userId = ctx.wizard.state?.userId;
    if (!userId) {
      logger.error(`User ID missing in wizard state at step 3`);
      await ctx.reply('Session error. Please start over with /sell.');
      return ctx.scene.leave();
    }

    logger.info(`User ${userId} at step 3, callback: ${JSON.stringify(ctx.callbackQuery)}`);

    if (!ctx.callbackQuery) {
      logger.warn(`No callbackQuery for user ${userId} in step 3`);
      await ctx.reply('Please select a bank option.');
      return ctx.scene.leave();
    }

    const userState = await getUserState(userId);
    let bankDetails = userState.bankDetails;

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
      ctx.wizard.state.bankDetails = bankDetails;
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
        tokenAddress: ctx.wizard.state.tokenAddress,
        chainId: ctx.wizard.state.chainId,
        bankDetails,
        blockradarAddress,
        status: 'pending',
        symbol: ctx.wizard.state.symbol,
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
      await ctx.editMessageText(msg, {
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.url('Connect Wallet', `${process.env.WEBAPP_URL}/connect?userId=${userId}&session=${sessionId}`)],
          [Markup.button.callback('❌ Cancel', 'cancel_sell')],
        ]).reply_markup,
        parse_mode: 'Markdown',
      });
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
        tokenAddress: ctx.wizard.state.tokenAddress,
        chainId: ctx.wizard.state.chainId,
        bankDetails: ctx.wizard.state.bankDetails,
        blockradarAddress,
        status: 'pending',
        symbol: ctx.wizard.state.symbol,
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
sellScene.action('confirm_token', async (ctx) => {
  logger.info(`User ${ctx.from.id} confirmed token`);
  try {
    await ctx.answerCbQuery();
    logger.info(`User ${ctx.from.id} advancing to step 2`);
    return ctx.wizard.next();
  } catch (error) {
    logger.error(`Error in confirm_token action for user ${ctx.from.id}: ${error.message}`);
    await ctx.reply('Error confirming token. Try again.');
    return ctx.scene.leave();
  }
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
